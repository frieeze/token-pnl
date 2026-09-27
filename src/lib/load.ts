// Orchestrates one page load: transfers + balance → historical prices → current price → PnL.
// Fetchers are injectable so this is unit-testable without the network.

import { getAddress } from 'viem'
import { computePnl, validPrice, type PnlResult } from './pnl'
import { fetchCurrentPrice, fetchHistoricalPrices } from './prices'
import { balanceOf, fetchTransfers } from './transfers'

export interface Fetchers {
  fetchTransfers: typeof fetchTransfers
  balanceOf: typeof balanceOf
  fetchHistoricalPrices: typeof fetchHistoricalPrices
  fetchCurrentPrice: typeof fetchCurrentPrice
}

export interface LoadOptions {
  onProgress?: (done: number, total: number) => void
  fetchers?: Fetchers
}

export interface LoadResult {
  symbol: string | null
  decimals: number
  /** `null` when the wallet has no transfers of this token. */
  pnl: PnlResult | null
  currentPrice: number | null
  onchainBalance: bigint
  /** held × current price; `null` when the current price is missing. */
  heldUsd: number | null
}

const defaultFetchers: Fetchers = { fetchTransfers, balanceOf, fetchHistoricalPrices, fetchCurrentPrice }

export async function loadPnl(token: string, wallet: string, opts: LoadOptions = {}): Promise<LoadResult> {
  const f = opts.fetchers ?? defaultFetchers
  const [{ symbol, decimals, movements }, onchainBalance] = await Promise.all([
    f.fetchTransfers(token, wallet),
    f.balanceOf(token, wallet),
  ])
  if (decimals === null) throw new Error("Could not read the token's decimals: is this an ERC-20 token?")

  if (movements.length === 0) return { symbol, decimals, pnl: null, currentPrice: null, onchainBalance, heldUsd: null }

  const tokenAddr = getAddress(token)
  const [prices, rawCurrentPrice] = await Promise.all([
    f.fetchHistoricalPrices(tokenAddr, movements.map((m) => m.timestamp), { onProgress: opts.onProgress }),
    f.fetchCurrentPrice(tokenAddr),
  ])
  // Clean once so the page never shows a bad value that the PnL treats as missing.
  const currentPrice = validPrice(rawCurrentPrice)

  const pnl = computePnl({
    decimals,
    movements: movements.map((m) => ({ ...m, price: prices.get(m.timestamp) ?? null })),
    currentPrice,
    onchainBalance,
  })
  // unrealized + cost = held × current price, reusing pnl's validation of the current price
  const heldUsd = pnl.totals.unrealized === null ? null : pnl.totals.unrealized + pnl.totals.cost
  return { symbol, decimals, pnl, currentPrice, onchainBalance, heldUsd }
}
