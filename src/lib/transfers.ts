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

export type Direction = 'buy' | 'sell'

export interface Movement {
  hash: `0x${string}`
  blockNumber: bigint
  transactionIndex: number
  timestamp: number // unix seconds
  direction: Direction
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

// Blockscout page size (`offset` query param). Checked live 2026-09-27 against a busy
// wallet/token pair (a large exchange wallet vs. USDC/USDT, hundreds of rows): offset
// values of 1000, 5000, 10000 and 20000 all returned valid JSON (status "1"). Blockscout's
// own IP rate limit ("Too many requests. Increase limits now at https://dev.blockscout.com",
// returned as an ordinary `status: "0"` JSON body, not an HTTP error) was hit after a
// handful of requests in quick succession, well before we could push a page size to
// failure on data volume alone. The issue's own quick test found offset=20000 returns a
// non-JSON response on some query. We default to 5000 - comfortably under both the known-bad
// 20000 and the values that answered cleanly here - and rely on pagination (several
// requests) rather than one very large page. Override via `opts.pageSize` if needed.
const DEFAULT_PAGE_SIZE = 5000

// Blockscout's Etherscan-compatible `tokentx` endpoint only ever exposes the first
// page * offset <= 10,000 rows of a result set; past that it either errors or silently
// omits rows, so we can't tell whether we've fetched everything. We throw instead of
// returning a truncated list. Fetching the remainder via block-range continuation
// (`startblock`/`endblock`) is tracked in https://github.com/frieeze/token-pnl/issues/10.
const MAX_ROWS = 10_000

// Lazily-created, shared across calls that don't inject their own client, so we don't
// spin up a new viem client (and its transport) per call.
let sharedClient: PublicClient | undefined

function defaultClient(): PublicClient {
  if (!sharedClient) {
    sharedClient = createPublicClient({ chain: mainnet, transport: http(DEFAULT_RPC_URL) })
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

function buildUrl(baseUrl: string, token: Address, wallet: Address, page: number, pageSize: number): string {
  const params = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    contractaddress: token,
    address: wallet,
    sort: 'asc',
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
): Promise<BlockscoutTx[]> {
  const rows: BlockscoutTx[] = []
  let page = 1

  for (;;) {
    const url = buildUrl(baseUrl, token, wallet, page, pageSize)
    const res = await fetchFn(url)
    if (!res.ok) {
      let detail: string = res.statusText
      try {
        const errorBody = await res.json()
        if (typeof errorBody?.message === 'string' && errorBody.message) detail = errorBody.message
      } catch {
        // body wasn't JSON: fall back to statusText, already the default
      }
      throw new Error(`Blockscout request failed: ${res.status} ${detail}`)
    }

    let body: BlockscoutResponse
    try {
      body = await res.json()
    } catch {
      throw new Error('Blockscout returned a non-JSON response')
    }

    if (body.status === '0') {
      if (/no transactions found/i.test(body.message ?? '')) break
      throw new Error(`Blockscout error: ${body.message || 'unknown error'}`)
    }

    const pageRows = Array.isArray(body.result) ? body.result : []
    rows.push(...pageRows)
    if (rows.length >= MAX_ROWS) {
      throw new Error(
        'This wallet has more than 10,000 transfers of this token; Blockscout cannot list them all yet',
      )
    }
    if (pageRows.length < pageSize) break
    page += 1
  }

  return rows
}

function toMovement(row: BlockscoutTx, wallet: Address): Movement | null {
  let from: Address
  let to: Address
  try {
    from = getAddress(row.from)
    to = getAddress(row.to)
  } catch {
    return null // malformed address in a row: skip rather than crash
  }

  const fromIsWallet = isAddressEqual(from, wallet)
  const toIsWallet = isAddressEqual(to, wallet)

  if (fromIsWallet && toIsWallet) return null // self-transfer: ignored (D1/D2, pnl-rules.md)
  if (!fromIsWallet && !toIsWallet) return null // defensive: row doesn't touch the wallet

  return {
    hash: row.hash as `0x${string}`,
    blockNumber: BigInt(row.blockNumber),
    transactionIndex: Number(row.transactionIndex),
    timestamp: Number(row.timeStamp),
    direction: toIsWallet ? 'buy' : 'sell',
    amount: BigInt(row.value),
  }
}

/**
 * Fetches every ERC-20 transfer of `token` touching `wallet` on Ethereum mainnet from
 * Blockscout, normalized to `Movement`s in chain order (block number, then transaction
 * index, then the order Blockscout returned them in - it gives no log index).
 *
 * If the wallet has no transfers, `movements` is an empty array. Since Blockscout then
 * gives no row to read `tokenSymbol`/`tokenDecimal` from, `symbol`/`decimals` are instead
 * read on-chain (`symbol()`/`decimals()`) via the injected (or default) viem public client.
 */
export async function fetchTransfers(
  token: string,
  wallet: string,
  opts: FetchTransfersOptions = {},
): Promise<FetchTransfersResult> {
  if (!isAddress(token)) throw new Error(`Invalid token address: ${token}`)
  if (!isAddress(wallet)) throw new Error(`Invalid wallet address: ${wallet}`)

  const tokenAddr = getAddress(token)
  const walletAddr = getAddress(wallet)
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE

  const rows = await fetchAllRows(tokenAddr, walletAddr, fetchFn, baseUrl, pageSize)

  const movements = rows
    .map((row) => toMovement(row, walletAddr))
    .filter((m): m is Movement => m !== null)

  // Stable sort: ties (same block, same tx index) keep the array's existing order, which
  // is the order Blockscout returned them in, as required by pnl-rules.md.
  movements.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
    return a.transactionIndex - b.transactionIndex
  })

  if (rows.length > 0) {
    const [first] = rows
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
