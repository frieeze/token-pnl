// PnL engine: weighted average cost, as specified in docs/pnl-rules.md.
// Pure module: no network, no Svelte, no clock.

import { formatUnits } from 'viem'

export type Direction = 'buy' | 'sell'

/** A movement with its USD price at the block timestamp (`null` when unpriced). */
export interface PricedMovement {
  hash: `0x${string}`
  /** Unix seconds. */
  timestamp: number
  direction: Direction
  /** Raw token amount (smallest unit). */
  amount: bigint
  price: number | null
}

export interface PnlInput {
  decimals: number
  /** Already in chain order. */
  movements: readonly PricedMovement[]
  currentPrice: number | null
  onchainBalance: bigint
}

export interface PnlTotals {
  realized: number
  /** `null` when the current price is missing. */
  unrealized: number | null
  /** `null` when `unrealized` is missing. */
  total: number | null
  held: bigint
  cost: number
  /** USD per whole token; `null` when nothing is held. */
  averageCost: number | null
  boughtQuantity: bigint
  boughtUsd: number
  soldQuantity: bigint
  soldUsd: number
}

export type IncompleteReason = 'unpriced' | 'oversell'

export interface PnlFlags {
  incomplete: boolean
  reasons: IncompleteReason[]
  unpricedCount: number
  oversell: boolean
  balanceMismatch: boolean
}

export interface PnlRow {
  timestamp: number
  hash: `0x${string}`
  direction: Direction
  amount: bigint
  price: number | null
  /** amount × price; `null` when unpriced. */
  usdValue: number | null
}

export interface PnlResult {
  totals: PnlTotals
  flags: PnlFlags
  rows: PnlRow[]
}

export function computePnl(input: PnlInput): PnlResult {
  const { decimals, movements, currentPrice } = input
  const toTokens = (raw: bigint) => Number(formatUnits(raw, decimals))

  let held = 0n
  let cost = 0
  let boughtQuantity = 0n
  let boughtUsd = 0
  let soldQuantity = 0n
  let soldUsd = 0
  let realized = 0
  let unpricedCount = 0
  let oversell = false
  const rows: PnlRow[] = []

  for (const m of movements) {
    const q = toTokens(m.amount)
    const p = m.price ?? 0
    if (m.price === null) unpricedCount += 1
    if (m.direction === 'buy') {
      held += m.amount
      cost += q * p
      boughtQuantity += m.amount
      boughtUsd += q * p
    } else {
      // Oversell clamp: only the part covered by `held` carries cost; the excess
      // leaves at average cost 0, so all its proceeds are realized.
      if (m.amount > held) oversell = true
      const covered = m.amount > held ? held : m.amount
      // A sell that empties the position removes the whole remaining cost,
      // so cost is exactly 0 on a full exit (no float dust).
      const removedCost = covered === held ? cost : toTokens(covered) * (cost / toTokens(held))
      realized += q * p - removedCost
      cost -= removedCost
      held -= covered
      soldQuantity += m.amount
      soldUsd += q * p
    }
    rows.push({
      timestamp: m.timestamp,
      hash: m.hash,
      direction: m.direction,
      amount: m.amount,
      price: m.price,
      usdValue: m.price === null ? null : q * m.price,
    })
  }

  const reasons: IncompleteReason[] = []
  if (unpricedCount > 0) reasons.push('unpriced')
  if (oversell) reasons.push('oversell')

  const heldTokens = toTokens(held)
  const unrealized = currentPrice === null ? null : heldTokens * currentPrice - cost

  return {
    totals: {
      realized,
      unrealized,
      total: unrealized === null ? null : realized + unrealized,
      held,
      cost,
      averageCost: held === 0n ? null : cost / heldTokens,
      boughtQuantity,
      boughtUsd,
      soldQuantity,
      soldUsd,
    },
    flags: {
      incomplete: reasons.length > 0,
      reasons,
      unpricedCount,
      oversell,
      balanceMismatch: held !== input.onchainBalance,
    },
    rows,
  }
}
