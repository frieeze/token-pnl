import {
  createPublicClient,
  erc20Abi,
  erc20Abi_bytes32,
  getAddress,
  hexToString,
  http,
  isAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { defaultCacheStorage, readCache, writeCache, type CacheStorage } from './cache'
import { fetchWithRetry } from './http'

export type Direction = 'in' | 'out'

export interface Movement {
  hash: `0x${string}`
  blockNumber: bigint
  transactionIndex: number
  timestamp: number // unix seconds
  direction: Direction
  /** The wallet it touches: `to` for in, `from` for out. */
  wallet: Address
  /** The other side: `from` for in, `to` for out. */
  counterparty: Address
  amount: bigint // raw token units
}

export interface FetchTransfersResult {
  symbol: string | null
  decimals: number | null
  movements: Movement[]
}

/** Minimal slice of viem's PublicClient our functions need, so tests can inject a stub. */
export type ReadContractClient = Pick<PublicClient, 'readContract'>

export interface FetchTransfersOptions {
  /** Injectable fetch, defaults to the global one. */
  fetch?: typeof globalThis.fetch
  /** Blockscout API base URL, defaults to the Ethereum mainnet instance. */
  baseUrl?: string
  /** Rows requested per page (Blockscout's `offset` param). */
  pageSize?: number
  /** viem client used to read `symbol`/`decimals` on-chain when there are no transfers. */
  publicClient?: ReadContractClient
  /** Injectable sleep for retry backoff, so tests don't really wait; defaults to a real one. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Where transfer history is cached per (token, wallet), so a reload only fetches what's new.
   * Defaults to `localStorage` when available. Pass `null` to disable caching.
   */
  cache?: CacheStorage | null
}

export interface BalanceOfOptions {
  publicClient?: ReadContractClient
}

// Public RPC for Ethereum mainnet, used as the default transport for the injectable viem
// client. Checked live 2026-09-27: ethereum-rpc.publicnode.com, cloudflare-eth.com and
// 1rpc.io all answered `eth_chainId` over POST with `access-control-allow-origin: *`,
// so any of them is callable straight from a browser with no key. llamarpc.com returned
// an HTTP 403 Cloudflare bot challenge on both OPTIONS and POST from this environment and
// was rejected. publicnode is used as the default: well-known, no auth required.
const DEFAULT_RPC_URL = 'https://ethereum-rpc.publicnode.com'

const DEFAULT_BASE_URL = 'https://eth.blockscout.com/api'

// Blockscout page size (`offset` query param). Must be at most RESULT_WINDOW; 5000 keeps each
// response to a few MB. Blockscout's IP rate limit ("Too many requests…") comes back as an
// ordinary `status: "0"` JSON body, not an HTTP error.
const DEFAULT_PAGE_SIZE = 5000

const DEFAULT_TIMEOUT_MS = 15_000

// `tokentx` only exposes page * offset <= 10,000 rows per query; past that it answers
// "Result window is too large" (checked live 2026-09-27, as was `startblock` with `sort=asc`).
// A full window can end mid-block and rows have no log index, so its last block is dropped
// and refetched whole as the start of the next window: no duplicate, no gap.
const RESULT_WINDOW = 10_000

// Safety cap on the whole history, so a huge wallet fails clearly instead of loading forever.
const MAX_ROWS = 200_000

// Lazily-created, shared across calls that don't inject their own client, so we don't
// spin up a new viem client (and its transport) per call.
let sharedClient: PublicClient | undefined

export function defaultClient(): PublicClient {
  if (!sharedClient) {
    // Batching: calls made in the same tick go out as one JSON-RPC batch request (the classifier relies on it).
    sharedClient = createPublicClient({ chain: mainnet, transport: http(DEFAULT_RPC_URL, { batch: { batchSize: 100 } }) })
  }
  return sharedClient
}

interface BlockscoutTx {
  hash: string
  blockNumber: string
  transactionIndex: string
  timeStamp: string
  from: string
  to: string
  value: string
  tokenSymbol?: string
  tokenDecimal?: string
}

interface BlockscoutResponse {
  status: string
  message: string
  result: BlockscoutTx[] | string
}

function buildUrl(
  baseUrl: string,
  token: Address,
  wallet: Address,
  startblock: string,
  page: number,
  pageSize: number,
): string {
  const params = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    contractaddress: token,
    address: wallet,
    sort: 'asc',
    startblock,
    page: String(page),
    offset: String(pageSize),
  })
  return `${baseUrl}?${params.toString()}`
}

async function fetchAllRows(
  token: Address,
  wallet: Address,
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  pageSize: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
  initialStartblock = '0',
): Promise<BlockscoutTx[]> {
  const rows: BlockscoutTx[] = []
  let startblock = initialStartblock

  for (;;) {
    const { rows: windowRows, full } = await fetchWindow(token, wallet, fetchFn, baseUrl, pageSize, startblock, sleep)
    // The block we start from was just seen, so an empty continuation means inconsistent data.
    if (startblock !== '0' && windowRows.length === 0) {
      throw new Error(`Blockscout returned no transfers from block ${startblock}, which it listed just before; try again`)
    }
    if (!full) return rows.concat(windowRows)

    const lastBlock = windowRows[windowRows.length - 1].blockNumber
    const kept = windowRows.filter((r) => r.blockNumber !== lastBlock)
    if (kept.length === 0) {
      throw new Error(
        `Wallet ${wallet} has at least ${windowRows.length.toLocaleString('en-US')} transfers of this token in block ${lastBlock}; Blockscout cannot list them all`,
      )
    }
    rows.push(...kept)
    if (rows.length > MAX_ROWS) {
      throw new Error(
        `Wallet ${wallet} has more than ${MAX_ROWS.toLocaleString('en-US')} transfers of this token; too many to load`,
      )
    }
    startblock = lastBlock
  }
}

/**
 * Fetches one result window from `startblock`: pages until a short page, or until the next
 * page would go past Blockscout's 10,000-row cap (`full`: there may be more rows after it).
 */
async function fetchWindow(
  token: Address,
  wallet: Address,
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  pageSize: number,
  startblock: string,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<{ rows: BlockscoutTx[]; full: boolean }> {
  const rows: BlockscoutTx[] = []

  for (let page = 1; ; page++) {
    const url = buildUrl(baseUrl, token, wallet, startblock, page, pageSize)
    const res = await fetchWithRetry(url, fetchFn, { timeoutMs: DEFAULT_TIMEOUT_MS, label: 'Blockscout', sleep })

    let body: BlockscoutResponse
    try {
      body = await res.json()
    } catch {
      throw new Error('Blockscout returned a non-JSON response')
    }

    if (body.status === '0') {
      if (/no transactions found/i.test(body.message ?? '')) return { rows, full: false }
      throw new Error(`Blockscout error: ${body.message || 'unknown error'}`)
    }

    const pageRows = Array.isArray(body.result) ? body.result : []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) return { rows, full: false }
    if ((page + 1) * pageSize > RESULT_WINDOW) return { rows, full: true }
  }
}

function toMovement(row: BlockscoutTx, wallet: Address, wallets: readonly Address[]): Movement | null {
  let from: Address
  let to: Address
  try {
    from = getAddress(row.from)
    to = getAddress(row.to)
  } catch {
    return null // malformed address in a row: skip rather than crash
  }

  // Between two of the wallets (or a self-transfer): ignored (D15, pnl-rules.md). Blockscout lists it
  // under both wallets, so it must be dropped from each list.
  if (wallets.some((w) => isAddressEqual(from, w)) && wallets.some((w) => isAddressEqual(to, w))) return null
  const toIsWallet = isAddressEqual(to, wallet)
  if (!toIsWallet && !isAddressEqual(from, wallet)) return null // defensive: row doesn't touch the wallet

  return {
    hash: row.hash as `0x${string}`,
    blockNumber: BigInt(row.blockNumber),
    transactionIndex: Number(row.transactionIndex),
    timestamp: Number(row.timeStamp),
    direction: toIsWallet ? 'in' : 'out',
    wallet,
    counterparty: toIsWallet ? from : to,
    amount: BigInt(row.value),
  }
}

/**
 * Fetches every ERC-20 transfer of `token` touching one of `wallets` on Ethereum mainnet from
 * Blockscout, normalized to `Movement`s merged in chain order (block number, then transaction
 * index, then the order Blockscout returned them in - it gives no log index; within one tx,
 * the wallets in the order given). Transfers between two of the wallets are dropped.
 *
 * If the wallets have no transfers, `movements` is an empty array. Since Blockscout then
 * gives no row to read `tokenSymbol`/`tokenDecimal` from, `symbol`/`decimals` are instead
 * read on-chain (`symbol()`/`decimals()`) via the injected (or default) viem public client.
 */
export async function fetchTransfers(
  token: string,
  wallets: readonly string[],
  opts: FetchTransfersOptions = {},
): Promise<FetchTransfersResult> {
  if (!isAddress(token)) throw new Error(`Invalid token address: ${token}`)
  const bad = wallets.find((w) => !isAddress(w))
  if (bad !== undefined) throw new Error(`Invalid wallet address: ${bad}`)

  const tokenAddr = getAddress(token)
  const walletAddrs = wallets.map((w) => getAddress(w))
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const cacheStorage = opts.cache === null ? undefined : (opts.cache ?? defaultCacheStorage())

  let first: BlockscoutTx | undefined
  const movements: Movement[] = []
  // One wallet at a time: parallel requests would trip Blockscout's IP rate limit sooner.
  for (const wallet of walletAddrs) {
    const cached = readCache(cacheStorage, tokenAddr, wallet)
    // The cached rows' last block may not have been fully indexed by Blockscout yet when it was
    // saved, so it's dropped and refetched whole along with anything newer.
    const resumeFrom = cached && cached.length > 0 ? cached[cached.length - 1]!.blockNumber : undefined
    const kept = cached && resumeFrom !== undefined ? cached.filter((r) => r.blockNumber !== resumeFrom) : []

    const fetched = await fetchAllRows(tokenAddr, wallet, fetchFn, baseUrl, pageSize, opts.sleep, resumeFrom)
    const walletRows = kept.concat(fetched)
    writeCache(cacheStorage, tokenAddr, wallet, walletRows)

    first ??= walletRows[0]
    for (const row of walletRows) {
      const m = toMovement(row, wallet, walletAddrs)
      if (m) movements.push(m)
    }
  }

  // Stable sort: ties (same block, same tx index) keep the array's existing order, which
  // is the wallets in the order given, then the order Blockscout returned them in (pnl-rules.md).
  movements.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
    return a.transactionIndex - b.transactionIndex
  })

  if (first) {
    return {
      symbol: first.tokenSymbol ?? null,
      decimals: first.tokenDecimal !== undefined ? Number(first.tokenDecimal) : null,
      movements,
    }
  }

  const client = opts.publicClient ?? defaultClient()
  const [symbol, decimals] = await Promise.all([
    readSymbol(client, tokenAddr),
    readDecimals(client, tokenAddr),
  ])
  return { symbol, decimals, movements }
}

/**
 * Reads `symbol()` on-chain. Most ERC-20s return a `string`, but some older tokens
 * (e.g. MKR) return a `bytes32` instead, which reverts against the standard ABI - so we
 * retry with the `bytes32` ABI and decode it, trimming the zero-padding.
 */
async function readSymbol(client: ReadContractClient, address: Address): Promise<string | null> {
  try {
    return await client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })
  } catch {
    // fall through to the bytes32 variant below
  }
  try {
    const raw = await client.readContract({ address, abi: erc20Abi_bytes32, functionName: 'symbol' })
    return hexToString(raw, { size: 32 }).replace(/\u0000+$/, '')
  } catch {
    return null
  }
}

async function readDecimals(client: ReadContractClient, address: Address): Promise<number | null> {
  try {
    return await client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })
  } catch {
    return null
  }
}

/** Reads the ERC-20 balance of `wallet` in `token` at the latest block. */
export async function balanceOf(token: string, wallet: string, opts: BalanceOfOptions = {}): Promise<bigint> {
  if (!isAddress(token)) throw new Error(`Invalid token address: ${token}`)
  if (!isAddress(wallet)) throw new Error(`Invalid wallet address: ${wallet}`)

  const client = opts.publicClient ?? defaultClient()
  return client.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getAddress(wallet)],
  })
}
