// Movement classifier, as specified in docs/pnl-rules.md (Classification, D10).

import { isAddressEqual, toEventSelector, zeroAddress, type Address, type Hash } from 'viem'
import { defaultCacheStorage, readTxCache, writeTxCache, type CacheStorage } from './cache'
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
  wallets: readonly Address[]
  /** In chain order. */
  movements: readonly Pick<Movement, 'hash' | 'direction' | 'counterparty' | 'amount'>[]
  txs: ReadonlyMap<Hash, TxData>
  /** Counterparties with code at the latest block (checksummed, like `Movement.counterparty`). */
  contracts: ReadonlySet<Address>
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)')

/** The address in an indexed topic (last 20 bytes). */
const topicAddress = (topic: Hash) => `0x${topic.slice(26)}` as Address

/**
 * Only the logs `legs()` reads: `Transfer` logs with 3 topics (any address - the token itself
 * is excluded there, and caching is shared across tokens), and WETH `Withdrawal` logs. Other
 * logs (Swap, Sync, Approval…) are dropped before caching, since receipts can be large.
 * Keep in step with the log checks in `legs()`.
 */
function logsForCache(logs: TxData['logs']): TxData['logs'] {
  return logs.filter(
    (log) =>
      (log.topics[0] === TRANSFER && log.topics.length === 3) ||
      (log.topics[0] === WITHDRAWAL && isAddressEqual(log.address, WETH)),
  )
}

/** What the wallets sent and received in `tx` besides `token` (any of them, D15). */
function legs(tx: TxData, token: Address, wallets: readonly Address[]) {
  const isWallet = (a: Address) => wallets.some((w) => isAddressEqual(a, w))
  const fromWallet = isWallet(tx.from)
  let tokenIn = false
  let tokenOut = false
  let minted = false
  let burned = false
  let unwrapped = false
  // Reading a new kind of log here? Keep it in `logsForCache` too, or cached txs will miss it.
  for (const log of tx.logs) {
    if (log.topics[0] === WITHDRAWAL && isAddressEqual(log.address, WETH)) unwrapped = true
    // ERC-20 Transfer only: ERC-721 has a fourth topic (the token id).
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3 || isAddressEqual(log.address, token)) continue
    // A zero-value transfer moves nothing (often address-poisoning spam): not a leg. The regex
    // also covers empty data (`0x`), where BigInt() would throw.
    if (/^0x0*$/.test(log.data)) continue
    const from = topicAddress(log.topics[1]!)
    const to = topicAddress(log.topics[2]!)
    const toWallet = isWallet(to)
    // Exactly one side among the wallets: a transfer between two of them is not a leg.
    if (toWallet === isWallet(from)) continue
    if (toWallet) {
      tokenIn = true
      if (isAddressEqual(from, zeroAddress)) minted = true
    } else {
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
function legRule(m: RulesMovement, tx: TxData, token: Address, wallets: readonly Address[]): MovementClass | null {
  const leg = legs(tx, token, wallets)
  if (m.direction === 'out' && leg.minted) return 'deposit'
  if (m.direction === 'in' && leg.burned) return 'withdraw'
  if (m.direction === 'in' && leg.out) return 'buy'
  if (m.direction === 'out' && leg.in) return 'sell'
  if (m.direction === 'in' && isAddressEqual(m.counterparty, zeroAddress)) return 'reward'
  return null
}

/** Applies the rules table (first match wins) to each movement, in chain order. */
export function applyRules(input: RulesInput): MovementClass[] {
  // Rule 7: amount deposited (rule 6) and not yet withdrawn, per contract across all the wallets, by our own count.
  const depositsOut = new Map<Address, bigint>()
  return input.movements.map((m) => {
    const byLegs = legRule(m, input.txs.get(m.hash)!, input.token, input.wallets)
    if (byLegs) return byLegs
    if (!input.contracts.has(m.counterparty)) return m.direction === 'out' ? 'transferOut' : 'transferIn'
    const out = depositsOut.get(m.counterparty) ?? 0n
    if (m.direction === 'out') {
      depositsOut.set(m.counterparty, out + m.amount)
      return 'deposit'
    }
    if (out === 0n) return 'reward'
    // The engine counts any excess over the amount out as a reward.
    depositsOut.set(m.counterparty, m.amount < out ? out - m.amount : 0n)
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
  /** Transactions fetched so far, out of the distinct tx hashes (cached ones count from the start). */
  onProgress?: (done: number, total: number) => void
  /**
   * Where each tx's classifier data is cached, keyed by hash only (shared across tokens and
   * wallet sets). Defaults to `localStorage` when available. Pass `null` to disable caching.
   */
  cache?: CacheStorage | null
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
  wallets: readonly Address[],
  movements: readonly Movement[],
  opts: ClassifyOptions = {},
): Promise<MovementClass[]> {
  const client = opts.publicClient ?? defaultClient()
  const cache = opts.cache === null ? undefined : (opts.cache ?? defaultCacheStorage())
  // A tx that touches several wallets is fetched once.
  const hashes = [...new Set(movements.map((m) => m.hash))]

  const txs = new Map<Hash, TxData>()
  const missing: Hash[] = []
  for (const hash of hashes) {
    const cached = readTxCache(cache, hash)
    if (cached) txs.set(hash, { from: cached.from as Address, value: BigInt(cached.value), logs: cached.logs as TxData['logs'] })
    else missing.push(hash)
  }

  opts.onProgress?.(txs.size, hashes.length)
  const fetched = await rpc(
    inChunks(
      missing,
      TXS_PER_CHUNK,
      async (hash) => {
        const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
        const data: TxData = { from: tx.from, value: tx.value, logs: receipt.logs }
        writeTxCache(cache, hash, { from: data.from, value: data.value.toString(), logs: [...logsForCache(data.logs)] })
        return [hash, data] as const
      },
      (done) => opts.onProgress?.(txs.size + done, hashes.length),
    ),
  )
  for (const [hash, data] of fetched) txs.set(hash, data)

  const toCheck = [
    ...new Set(movements.filter((m) => !legRule(m, txs.get(m.hash)!, token, wallets)).map((m) => m.counterparty)),
  ]
  const codes = await rpc(inChunks(toCheck, CODES_PER_CHUNK, (address) => client.getCode({ address })))
  // An EOA with an EIP-7702 delegation has code `0xef0100‖address`: still a wallet, not a contract.
  const isContract = (code: Hash | undefined) => code !== undefined && code !== '0x' && !code.startsWith('0xef0100')
  const contracts = new Set(toCheck.filter((_, i) => isContract(codes[i])))

  return applyRules({ token, wallets, movements, txs, contracts })
}

/** Rethrows an RPC failure with a message the page can show. */
async function rpc<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (err) {
    const detail = (err as { shortMessage?: string })?.shortMessage ?? (err instanceof Error ? err.message : String(err))
    throw new Error(`RPC request failed while classifying movements: ${detail}`)
  }
}
