import { describe, expect, it, vi } from 'vitest'
import { loadPnl, type Fetchers } from './load'
import type { Movement } from './transfers'

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const WALLET = '0xF977814e90dA44bFA03b6295A0616a897441aceC'

function mv(direction: Movement['direction'], amount: bigint, timestamp: number): Movement {
  return { hash: `0x${String(timestamp).padStart(64, '0')}`, blockNumber: BigInt(timestamp), transactionIndex: 0, timestamp, direction, amount }
}

function fakes(overrides: Partial<Fetchers> = {}): Fetchers {
  return {
    fetchTransfers: vi.fn(async () => ({
      symbol: 'TKN',
      decimals: 18,
      movements: [mv('buy', 10n * 10n ** 18n, 100), mv('sell', 4n * 10n ** 18n, 200)],
    })),
    balanceOf: vi.fn(async () => 6n * 10n ** 18n),
    fetchHistoricalPrices: vi.fn(async () => new Map([[100, 1], [200, 3]])),
    fetchCurrentPrice: vi.fn(async () => 5),
    ...overrides,
  }
}

describe('loadPnl', () => {
  it('prices each movement at its timestamp and computes the PnL', async () => {
    const res = await loadPnl(TOKEN, WALLET, { fetchers: fakes() })
    // bought 10 @ $1, sold 4 @ $3: realized 4×(3−1) = 8; held 6 @ $5 = 30, cost 6 → unrealized 24
    expect(res.symbol).toBe('TKN')
    expect(res.pnl?.totals.realized).toBe(8)
    expect(res.pnl?.totals.unrealized).toBe(24)
    expect(res.pnl?.totals.total).toBe(32)
    expect(res.heldUsd).toBe(30)
    expect(res.pnl?.flags.balanceMismatch).toBe(false)
    expect(res.pnl?.rows.map((r) => r.price)).toEqual([1, 3])
  })

  it('returns no PnL and fetches no prices when the wallet has no transfers', async () => {
    const f = fakes({ fetchTransfers: vi.fn(async () => ({ symbol: 'TKN', decimals: 18, movements: [] })) })
    const res = await loadPnl(TOKEN, WALLET, { fetchers: f })
    expect(res.pnl).toBeNull()
    expect(f.fetchHistoricalPrices).not.toHaveBeenCalled()
    expect(f.fetchCurrentPrice).not.toHaveBeenCalled()
  })

  it('forwards pricing progress', async () => {
    const f = fakes({
      fetchHistoricalPrices: vi.fn(async (_t, _ts, opts) => {
        opts?.onProgress?.(2, 2)
        return new Map([[100, 1], [200, 3]])
      }),
    })
    const onProgress = vi.fn()
    await loadPnl(TOKEN, WALLET, { fetchers: f, onProgress })
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it('leaves a movement DefiLlama has no price for unpriced', async () => {
    const f = fakes({ fetchHistoricalPrices: vi.fn(async () => new Map([[100, 1], [200, null]])) })
    const res = await loadPnl(TOKEN, WALLET, { fetchers: f })
    expect(res.pnl?.rows[1]?.price).toBeNull()
    expect(res.pnl?.flags.unpricedCount).toBe(1)
  })

  it('reports held value and unrealized as missing when there is no current price', async () => {
    const res = await loadPnl(TOKEN, WALLET, { fetchers: fakes({ fetchCurrentPrice: vi.fn(async () => null) }) })
    expect(res.heldUsd).toBeNull()
    expect(res.pnl?.totals.total).toBeNull()
  })

  it('flags a mismatch with the on-chain balance', async () => {
    const res = await loadPnl(TOKEN, WALLET, { fetchers: fakes({ balanceOf: vi.fn(async () => 5n) }) })
    expect(res.pnl?.flags.balanceMismatch).toBe(true)
  })

  it('fails clearly when the token decimals cannot be read', async () => {
    const f = fakes({ fetchTransfers: vi.fn(async () => ({ symbol: null, decimals: null, movements: [] })) })
    await expect(loadPnl(TOKEN, WALLET, { fetchers: f })).rejects.toThrow(/decimals/)
  })
})
