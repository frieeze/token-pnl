// Orchestrates one page load: transfers + balance → classes → historical prices → current price → PnL.
// Fetchers are injectable so this is unit-testable without the network.

import { getAddress, type Address } from 'viem'
import { classifyMovements } from './classify'
import { computePnl, validPrice, type PnlResult, type PricedMovement } from './pnl'
import { fetchCurrentPrice, fetchHistoricalPrices } from './prices'
import { balanceOf, fetchTransfers } from './transfers'

export interface Fetchers {
  fetchTransfers: typeof fetchTransfers
  classifyMovements: typeof classifyMovements
  balanceOf: typeof balanceOf
  fetchHistoricalPrices: typeof fetchHistoricalPrices
  fetchCurrentPrice: typeof fetchCurrentPrice
}

/** Which part of the load `onProgress` reports on. */
export type LoadStep = 'classify' | 'price'

export interface LoadOptions {
  /** `classify`: transactions fetched; `price`: timestamps priced. */
  onProgress?: (done: number, total: number, step: LoadStep) => void
  fetchers?: Fetchers
}

export interface LoadResult {
  symbol: string | null
  decimals: number
  /** `null` when the wallets have no transfers of this token. */
  pnl: PnlResult | null
  currentPrice: number | null
  /** Sum of the wallets' balances. */
  onchainBalance: bigint
  /** held × current price; `null` when the current price is missing. */
  heldUsd: number | null
  /**
   * The classified, priced movements `pnl` was computed from (in chain order), so the page can
   * recompute the PnL locally (e.g. after a class override) without refetching. `[]` when `pnl` is null.
   */
  movements: (PricedMovement & { wallet: Address })[]
}

const defaultFetchers: Fetchers = { fetchTransfers, classifyMovements, balanceOf, fetchHistoricalPrices, fetchCurrentPrice }

/** One PnL over all of `wallets` (D15). They must be distinct: a repeated wallet is counted twice. */
export async function loadPnl(token: string, wallets: readonly string[], opts: LoadOptions = {}): Promise<LoadResult> {
  const f = opts.fetchers ?? defaultFetchers
  const [{ symbol, decimals, movements }, balances] = await Promise.all([
    f.fetchTransfers(token, wallets),
    Promise.all(wallets.map((w) => f.balanceOf(token, w))),
  ])
  const onchainBalance = balances.reduce((a, b) => a + b, 0n)
  if (decimals === null) throw new Error("Could not read the token's decimals: is this an ERC-20 token?")

  if (movements.length === 0) {
    return { symbol, decimals, pnl: null, currentPrice: null, onchainBalance, heldUsd: null, movements: [] }
  }

  const tokenAddr = getAddress(token)
  const classes = await f.classifyMovements(tokenAddr, wallets.map((w) => getAddress(w)), movements, {
    onProgress: (done, total) => opts.onProgress?.(done, total, 'classify'),
  })
  const [prices, rawCurrentPrice] = await Promise.all([
    f.fetchHistoricalPrices(tokenAddr, movements.map((m) => m.timestamp), {
      onProgress: (done, total) => opts.onProgress?.(done, total, 'price'),
    }),
    f.fetchCurrentPrice(tokenAddr),
  ])
  // Clean once so the page never shows a bad value that the PnL treats as missing.
  const currentPrice = validPrice(rawCurrentPrice)

  const priced = movements.map((m, i) => ({
    hash: m.hash,
    timestamp: m.timestamp,
    wallet: m.wallet,
    class: classes[i]!,
    amount: m.amount,
    price: prices.get(m.timestamp) ?? null,
  }))
  const pnl = computePnl({ decimals, movements: priced, currentPrice, onchainBalance })
  // unrealized + cost = held × current price, reusing pnl's validation of the current price
  const heldUsd = pnl.totals.unrealized === null ? null : pnl.totals.unrealized + pnl.totals.cost
  return { symbol, decimals, pnl, currentPrice, onchainBalance, heldUsd, movements: priced }
}
