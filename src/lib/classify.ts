// Movement classifier, as specified in docs/pnl-rules.md (Classification, D10).

import { isAddressEqual, toEventSelector, zeroAddress, type Address, type Hash } from 'viem'
import type { MovementClass } from './pnl'
import { defaultClient, type Movement } from './transfers'

/** What the classifier needs from a transaction and its receipt. */
export interface TxData {
  from: Address
  value: bigint
  logs: readonly { address: Address; topics: readonly Hash[]; data: Hash }[]
}

export interface RulesInput {
  token: Address
  wallet: Address
  /** In chain order. */
  movements: readonly Pick<Movement, 'hash' | 'direction' | 'counterparty'>[]
  txs: ReadonlyMap<Hash, TxData>
  /** Counterparties with code at the latest block (checksummed, like `Movement.counterparty`). */
  contracts: ReadonlySet<Address>
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)')

/** The address in an indexed topic (last 20 bytes). */
const topicAddress = (topic: Hash) => `0x${topic.slice(26)}` as Address

/** What the wallet sent and received in `tx` besides `token`. */
function legs(tx: TxData, token: Address, wallet: Address) {
  const fromWallet = isAddressEqual(tx.from, wallet)
  let tokenIn = false
  let tokenOut = false
  let minted = false
  let burned = false
  let unwrapped = false
  for (const log of tx.logs) {
    if (log.topics[0] === WITHDRAWAL && isAddressEqual(log.address, WETH)) unwrapped = true
    // ERC-20 Transfer only: ERC-721 has a fourth topic (the token id).
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3 || isAddressEqual(log.address, token)) continue
    const from = topicAddress(log.topics[1]!)
    const to = topicAddress(log.topics[2]!)
    if (isAddressEqual(to, wallet)) {
      tokenIn = true
      if (isAddressEqual(from, zeroAddress)) minted = true
    }
    if (isAddressEqual(from, wallet)) {
      tokenOut = true
      if (isAddressEqual(to, zeroAddress)) burned = true
    }
  }
  return { minted, burned, in: tokenIn || (fromWallet && unwrapped), out: tokenOut || (fromWallet && tx.value > 0n) }
}

type RulesMovement = RulesInput['movements'][number]

/**
 * Rules 1–5: the ones decided by the tx alone. `null` when the counterparty's code decides.
 * After rules 3–4 no opposite leg is left, so a leg in the same direction (e.g. two reward
 * tokens claimed at once) does not block rules 5–8.
 */
function legRule(m: RulesMovement, tx: TxData, token: Address, wallet: Address): MovementClass | null {
  const leg = legs(tx, token, wallet)
  if (m.direction === 'out' && leg.minted) return 'deposit'
  if (m.direction === 'in' && leg.burned) return 'withdraw'
  if (m.direction === 'in' && leg.out) return 'buy'
  if (m.direction === 'out' && leg.in) return 'sell'
  if (m.direction === 'in' && isAddressEqual(m.counterparty, zeroAddress)) return 'reward'
  return null
}

/** Applies the rules table (first match wins) to each movement, in chain order. */
export function applyRules(input: RulesInput): MovementClass[] {
  // Rule 7: deposits (rule 6) still out, per contract, by our own count.
  const depositsOut = new Map<Address, number>()
  return input.movements.map((m) => {
    const byLegs = legRule(m, input.txs.get(m.hash)!, input.token, input.wallet)
    if (byLegs) return byLegs
    if (!input.contracts.has(m.counterparty)) return m.direction === 'out' ? 'transferOut' : 'transferIn'
    const out = depositsOut.get(m.counterparty) ?? 0
    if (m.direction === 'out') {
      depositsOut.set(m.counterparty, out + 1)
      return 'deposit'
    }
    if (out === 0) return 'reward'
    depositsOut.set(m.counterparty, out - 1)
    return 'withdraw'
  })
}

/** The slice of viem's PublicClient the classifier needs, so tests can inject a stub. */
export interface TxClient {
  getTransaction(args: { hash: Hash }): Promise<{ from: Address; value: bigint }>
  getTransactionReceipt(args: { hash: Hash }): Promise<{ logs: TxData['logs'] }>
  getCode(args: { address: Address }): Promise<Hash | undefined>
}

export interface ClassifyOptions {
  publicClient?: TxClient
  /** Transactions fetched so far, out of the distinct tx hashes. */
  onProgress?: (done: number, total: number) => void
}

// Calls made in one chunk go out as one JSON-RPC batch (the default client batches up to 100 calls).
const TXS_PER_CHUNK = 50 // 2 calls each
const CODES_PER_CHUNK = 100

/** Runs `fn` over `items` a chunk at a time, so each chunk is one HTTP request. */
async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>, onChunk?: (done: number) => void) {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
    onChunk?.(out.length)
  }
  return out
}

/**
 * Classifies `movements` (in chain order) from their transactions, receipts and the code of
 * their counterparties, read from the RPC. Returns one class per movement, in the same order.
 */
export async function classifyMovements(
  token: Address,
  wallet: Address,
  movements: readonly Movement[],
  opts: ClassifyOptions = {},
): Promise<MovementClass[]> {
  const client = opts.publicClient ?? defaultClient()
  try {
    const hashes = [...new Set(movements.map((m) => m.hash))]
    opts.onProgress?.(0, hashes.length)
    const fetched = await inChunks(
      hashes,
      TXS_PER_CHUNK,
      async (hash) => {
        const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
        return [hash, { from: tx.from, value: tx.value, logs: receipt.logs }] as const
      },
      (done) => opts.onProgress?.(done, hashes.length),
    )
    const txs = new Map<Hash, TxData>(fetched)

    const toCheck = [
      ...new Set(movements.filter((m) => !legRule(m, txs.get(m.hash)!, token, wallet)).map((m) => m.counterparty)),
    ]
    const codes = await inChunks(toCheck, CODES_PER_CHUNK, (address) => client.getCode({ address }))
    const contracts = new Set(toCheck.filter((_, i) => codes[i] !== undefined && codes[i] !== '0x'))

    return applyRules({ token, wallet, movements, txs, contracts })
  } catch (err) {
    const detail = (err as { shortMessage?: string })?.shortMessage ?? (err instanceof Error ? err.message : String(err))
    throw new Error(`RPC request failed while classifying movements: ${detail}`)
  }
}
