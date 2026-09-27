import { describe, expect, it } from 'vitest'
import { computePnl, type PricedMovement } from './pnl'

// Helpers: 18-decimals token, amounts written in whole tokens.
const DEC = 18
const units = (tokens: bigint) => tokens * 10n ** 18n

let seq = 0
function mv(direction: 'buy' | 'sell', tokens: bigint, price: number | null): PricedMovement {
  seq += 1
  return {
    hash: `0x${seq.toString(16).padStart(64, '0')}`,
    timestamp: 1_700_000_000 + seq,
    direction,
    amount: units(tokens),
    price,
  }
}

describe('computePnl', () => {
  it('no movements: everything is zero, total defined', () => {
    const r = computePnl({ decimals: DEC, movements: [], currentPrice: 2, onchainBalance: 0n })
    // held 0, cost 0 → unrealized = 0*2 - 0 = 0, total = 0 + 0 = 0
    expect(r.totals.realized).toBe(0)
    expect(r.totals.unrealized).toBe(0)
    expect(r.totals.total).toBe(0)
    expect(r.totals.held).toBe(0n)
    expect(r.totals.cost).toBe(0)
    expect(r.totals.averageCost).toBeNull()
    expect(r.flags.incomplete).toBe(false)
    expect(r.flags.balanceMismatch).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('single buy then hold: unrealized from current price', () => {
    const buy = mv('buy', 100n, 2)
    const r = computePnl({ decimals: DEC, movements: [buy], currentPrice: 3, onchainBalance: units(100n) })
    // buy 100 @ 2 → held 100, cost 200, avg 2
    // unrealized = 100*3 - 200 = 100; realized 0; total 100
    expect(r.totals.held).toBe(units(100n))
    expect(r.totals.cost).toBeCloseTo(200)
    expect(r.totals.averageCost).toBeCloseTo(2)
    expect(r.totals.realized).toBe(0)
    expect(r.totals.unrealized).toBeCloseTo(100)
    expect(r.totals.total).toBeCloseTo(100)
    expect(r.totals.boughtQuantity).toBe(units(100n))
    expect(r.totals.boughtUsd).toBeCloseTo(200)
    expect(r.totals.soldQuantity).toBe(0n)
    expect(r.totals.soldUsd).toBe(0)
    expect(r.flags.incomplete).toBe(false)
    expect(r.flags.balanceMismatch).toBe(false)
    // row USD value = 100 * 2 = 200
    expect(r.rows).toEqual([
      { timestamp: buy.timestamp, hash: buy.hash, direction: 'buy', amount: units(100n), price: 2, usdValue: 200 },
    ])
  })

  it('buy, buy, partial sell: sells at weighted average cost', () => {
    const movements = [mv('buy', 100n, 1), mv('buy', 100n, 3), mv('sell', 50n, 4)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 5, onchainBalance: units(150n) })
    // buy 100 @ 1 → held 100, cost 100
    // buy 100 @ 3 → held 200, cost 400, avg 2
    // sell 50 @ 4 → realized = 50*(4-2) = 100, cost = 400 - 50*2 = 300, held 150
    // unrealized = 150*5 - 300 = 450; total = 100 + 450 = 550
    expect(r.totals.held).toBe(units(150n))
    expect(r.totals.cost).toBeCloseTo(300)
    expect(r.totals.averageCost).toBeCloseTo(2)
    expect(r.totals.realized).toBeCloseTo(100)
    expect(r.totals.unrealized).toBeCloseTo(450)
    expect(r.totals.total).toBeCloseTo(550)
    // bought 200 for 100 + 300 = 400 USD; sold 50 for 50*4 = 200 USD
    expect(r.totals.boughtQuantity).toBe(units(200n))
    expect(r.totals.boughtUsd).toBeCloseTo(400)
    expect(r.totals.soldQuantity).toBe(units(50n))
    expect(r.totals.soldUsd).toBeCloseTo(200)
    // row USD values: 100*1, 100*3, 50*4
    expect(r.rows.map((row) => row.usdValue)).toEqual([100, 300, 200])
    expect(r.rows.map((row) => row.direction)).toEqual(['buy', 'buy', 'sell'])
  })

  it('full exit over several sells: cost is exactly 0 (no float dust), unrealized 0', () => {
    // These prices leave 4.44e-16 of cost with naive float math, so the test pins the exact-zero rule.
    const movements = [
      mv('buy', 3n, 0.1),
      mv('buy', 7n, 0.7),
      mv('sell', 1n, 1),
      mv('sell', 3n, 1),
      mv('sell', 6n, 1),
    ]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 2, onchainBalance: 0n })
    // buys: held 10, cost 3*0.1 + 7*0.7 = 0.3 + 4.9 = 5.2, avg 0.52
    // sells of 1, 3, 6 @ 1 at avg 0.52: realized = 10*(1 - 0.52) = 4.8, held 0, cost 0
    // unrealized = 0*2 - 0 = 0; total 4.8
    expect(r.totals.held).toBe(0n)
    expect(r.totals.cost).toBe(0)
    expect(r.totals.averageCost).toBeNull()
    expect(r.totals.unrealized).toBe(0)
    expect(r.totals.realized).toBeCloseTo(4.8)
    expect(r.totals.total).toBeCloseTo(4.8)
    expect(r.flags.incomplete).toBe(false)
  })

  it('sell at a loss: negative realized', () => {
    const movements = [mv('buy', 10n, 5), mv('sell', 4n, 2)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 1, onchainBalance: units(6n) })
    // buy 10 @ 5 → cost 50, avg 5
    // sell 4 @ 2 → realized = 4*(2-5) = -12, cost = 50 - 20 = 30, held 6
    // unrealized = 6*1 - 30 = -24; total = -12 + -24 = -36
    expect(r.totals.realized).toBeCloseTo(-12)
    expect(r.totals.cost).toBeCloseTo(30)
    expect(r.totals.unrealized).toBeCloseTo(-24)
    expect(r.totals.total).toBeCloseTo(-36)
    expect(r.totals.soldUsd).toBeCloseTo(8) // 4*2
  })

  it('unpriced buy: counts at price 0 and flags incomplete', () => {
    const movements = [mv('buy', 10n, 2), mv('buy', 10n, null)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 3, onchainBalance: units(20n) })
    // buy 10 @ 2 → cost 20; buy 10 unpriced → price 0, held 20, cost 20, avg 1
    // unrealized = 20*3 - 20 = 40; realized 0; total 40
    expect(r.totals.held).toBe(units(20n))
    expect(r.totals.cost).toBeCloseTo(20)
    expect(r.totals.averageCost).toBeCloseTo(1)
    expect(r.totals.unrealized).toBeCloseTo(40)
    expect(r.totals.total).toBeCloseTo(40)
    expect(r.totals.boughtQuantity).toBe(units(20n))
    expect(r.totals.boughtUsd).toBeCloseTo(20) // 10*2 + 10*0
    expect(r.flags.incomplete).toBe(true)
    expect(r.flags.reasons).toEqual(['unpriced'])
    expect(r.flags.unpricedCount).toBe(1)
    expect(r.flags.oversell).toBe(false)
    // the unpriced row keeps price null and has no USD value
    expect(r.rows[1]).toMatchObject({ price: null, usdValue: null })
  })

  it('unpriced sell: proceeds count as 0, cost still leaves at average cost', () => {
    const movements = [mv('buy', 10n, 4), mv('sell', 5n, null)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 6, onchainBalance: units(5n) })
    // buy 10 @ 4 → cost 40, avg 4
    // sell 5 unpriced (p = 0) → realized = 5*(0-4) = -20, cost = 40 - 20 = 20, held 5
    // unrealized = 5*6 - 20 = 10; total = -20 + 10 = -10
    expect(r.totals.realized).toBeCloseTo(-20)
    expect(r.totals.cost).toBeCloseTo(20)
    expect(r.totals.held).toBe(units(5n))
    expect(r.totals.unrealized).toBeCloseTo(10)
    expect(r.totals.total).toBeCloseTo(-10)
    expect(r.totals.soldQuantity).toBe(units(5n))
    expect(r.totals.soldUsd).toBe(0)
    expect(r.flags.incomplete).toBe(true)
    expect(r.flags.reasons).toEqual(['unpriced'])
    expect(r.flags.unpricedCount).toBe(1)
  })

  it('missing current price: unrealized and total are null, realized still computed', () => {
    const movements = [mv('buy', 10n, 1), mv('sell', 4n, 3)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: null, onchainBalance: units(6n) })
    // buy 10 @ 1 → cost 10, avg 1; sell 4 @ 3 → realized = 4*(3-1) = 8, cost 6, held 6
    expect(r.totals.realized).toBeCloseTo(8)
    expect(r.totals.cost).toBeCloseTo(6)
    expect(r.totals.unrealized).toBeNull()
    expect(r.totals.total).toBeNull()
    // a missing current price is not an "incomplete" reason: the null totals already say it
    expect(r.flags.incomplete).toBe(false)
  })

  it('oversell: clamps held at 0, excess sold at average cost 0, flags incomplete', () => {
    const movements = [mv('buy', 10n, 2), mv('sell', 15n, 3)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 4, onchainBalance: 0n })
    // buy 10 @ 2 → cost 20, avg 2
    // sell 15 @ 3: 10 covered at avg 2 → 10*(3-2) = 10; excess 5 at avg 0 → 5*3 = 15
    // realized = 25, held 0 (clamped), cost 0; unrealized = 0*4 - 0 = 0; total 25
    expect(r.totals.held).toBe(0n)
    expect(r.totals.cost).toBe(0)
    expect(r.totals.realized).toBeCloseTo(25)
    expect(r.totals.unrealized).toBe(0)
    expect(r.totals.total).toBeCloseTo(25)
    // sold quantity is what left the wallet: 15; sold USD = 15*3 = 45
    expect(r.totals.soldQuantity).toBe(units(15n))
    expect(r.totals.soldUsd).toBeCloseTo(45)
    expect(r.flags.incomplete).toBe(true)
    expect(r.flags.reasons).toEqual(['oversell'])
    expect(r.flags.oversell).toBe(true)
    expect(r.flags.balanceMismatch).toBe(false)
  })

  it('balance mismatch: flagged, numbers unchanged, not an incomplete reason', () => {
    const movements = [mv('buy', 100n, 2)]
    // on-chain says 99 tokens (e.g. fee-on-transfer), computed held is 100
    const r = computePnl({ decimals: DEC, movements, currentPrice: 3, onchainBalance: units(99n) })
    // same numbers as "single buy then hold": held 100, cost 200, unrealized 100*3 - 200 = 100
    expect(r.flags.balanceMismatch).toBe(true)
    expect(r.flags.incomplete).toBe(false)
    expect(r.totals.held).toBe(units(100n))
    expect(r.totals.cost).toBeCloseTo(200)
    expect(r.totals.unrealized).toBeCloseTo(100)
  })

  it('uses the token decimals for fractional amounts', () => {
    // 6-decimals token: 1_500_000 raw = 1.5 tokens, 500_000 raw = 0.5 tokens
    const buy = { ...mv('buy', 0n, 2), amount: 1_500_000n }
    const sell = { ...mv('sell', 0n, 4), amount: 500_000n }
    const r = computePnl({ decimals: 6, movements: [buy, sell], currentPrice: 3, onchainBalance: 1_000_000n })
    // buy 1.5 @ 2 → cost 3, avg 2; sell 0.5 @ 4 → realized = 0.5*(4-2) = 1, cost 2, held 1.0
    // unrealized = 1*3 - 2 = 1; total 2
    expect(r.totals.held).toBe(1_000_000n)
    expect(r.totals.cost).toBeCloseTo(2)
    expect(r.totals.realized).toBeCloseTo(1)
    expect(r.totals.unrealized).toBeCloseTo(1)
    expect(r.totals.total).toBeCloseTo(2)
    expect(r.rows.map((row) => row.usdValue)).toEqual([3, 2]) // 1.5*2, 0.5*4
  })

  it('handles huge supplies without breaking (420e12 tokens, 18 decimals)', () => {
    const tokens = 420_000_000_000_000n // 420e12 tokens → 4.2e32 raw units
    const buy = mv('buy', tokens, 1e-8)
    const r = computePnl({ decimals: DEC, movements: [buy], currentPrice: 2e-8, onchainBalance: units(tokens) })
    // cost = 4.2e14 * 1e-8 = 4.2e6; unrealized = 4.2e14 * 2e-8 - 4.2e6 = 8.4e6 - 4.2e6 = 4.2e6
    expect(r.totals.held).toBe(units(tokens)) // bigint quantity is exact
    expect(r.totals.cost).toBeCloseTo(4.2e6, 2)
    expect(r.totals.averageCost).toBeCloseTo(1e-8, 15)
    expect(r.totals.unrealized).toBeCloseTo(4.2e6, 2)
    expect(r.flags.balanceMismatch).toBe(false)
  })

  it('reports both incomplete reasons when a movement is unpriced and a sell oversells', () => {
    const movements = [mv('buy', 10n, null), mv('sell', 12n, 1)]
    const r = computePnl({ decimals: DEC, movements, currentPrice: 1, onchainBalance: 0n })
    // buy 10 unpriced → cost 0; sell 12 @ 1: 10 covered at avg 0 + 2 excess at avg 0
    // realized = 12*1 - 0 = 12; held 0, cost 0, unrealized 0, total 12
    expect(r.totals.realized).toBeCloseTo(12)
    expect(r.totals.total).toBeCloseTo(12)
    expect(r.flags.incomplete).toBe(true)
    expect(r.flags.reasons).toEqual(['unpriced', 'oversell'])
    expect(r.flags.unpricedCount).toBe(1)
  })

  it('a sell with nothing held is entirely excess (no division by zero)', () => {
    const r = computePnl({ decimals: DEC, movements: [mv('sell', 5n, 2)], currentPrice: 2, onchainBalance: 0n })
    // held 0 → whole sell is excess at avg 0: realized = 5*2 = 10, held 0, cost 0
    expect(r.totals.realized).toBeCloseTo(10)
    expect(r.totals.cost).toBe(0)
    expect(r.totals.held).toBe(0n)
    expect(r.flags.oversell).toBe(true)
  })

  it('accepts movements shaped like #2 transfers spread with a price', () => {
    // Same shape as the Movement exported by src/lib/transfers.ts (#2), plus `price`.
    const movement = {
      hash: '0xabc' as const,
      blockNumber: 19_000_000n,
      transactionIndex: 3,
      timestamp: 1_700_000_000,
      direction: 'buy' as const,
      amount: units(2n),
    }
    const r = computePnl({
      decimals: DEC,
      movements: [{ ...movement, price: 5 }],
      currentPrice: 5,
      onchainBalance: units(2n),
    })
    // buy 2 @ 5 → cost 10; unrealized = 2*5 - 10 = 0
    expect(r.totals.cost).toBeCloseTo(10)
    expect(r.totals.unrealized).toBeCloseTo(0)
    expect(r.rows[0]).toEqual({
      timestamp: 1_700_000_000,
      hash: '0xabc',
      direction: 'buy',
      amount: units(2n),
      price: 5,
      usdValue: 10,
    })
  })
})
