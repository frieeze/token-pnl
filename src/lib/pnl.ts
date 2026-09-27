// PnL engine: weighted average cost, as specified in docs/pnl-rules.md.
// Pure module: no network, no Svelte, no clock.

import { formatUnits, type Hash } from 'viem'

/** The class assigned to a movement (D10). Determines how it is accounted for. */
export type MovementClass = 'buy' | 'sell' | 'deposit' | 'withdraw' | 'reward' | 'transferIn' | 'transferOut'

/** Only these classes need a price; a missing price on any other class is not a flag. */
const PRICED_CLASSES: readonly MovementClass[] = ['buy', 'sell', 'transferIn']

/** A movement with its USD price at the block timestamp (`null` when unpriced). */
export interface PricedMovement {
  hash: Hash
  /** Unix seconds. */
  timestamp: number
  class: MovementClass
  /** Raw token amount (smallest unit). */
  amount: bigint
  /** `null`, or a value that is not a finite number ≥ 0, means unpriced. */
  price: number | null
}

export interface PnlInput {
  decimals: number
  /** Already in chain order. */
  movements: readonly PricedMovement[]
  /** `null`, or a value that is not a finite number ≥ 0, means missing. */
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
  /** Token quantity currently out in protocols (still counted in `held`). */
  deposited: bigint
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
  hash: Hash
  class: MovementClass
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

/** A usable USD price, or `null`: prices come from an external API, so bad values count as missing. */
export const validPrice = (price: number | null) => (price !== null && Number.isFinite(price) && price >= 0 ? price : null)

export function computePnl(input: PnlInput): PnlResult {
  const { decimals, movements } = input
  const currentPrice = validPrice(input.currentPrice)
  const toTokens = (raw: bigint) => Number(formatUnits(raw, decimals))

  let held = 0n
  let deposited = 0n
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
    if (m.amount < 0n) throw new RangeError(`Negative amount in movement ${m.hash}`)
    const needsPrice = PRICED_CLASSES.includes(m.class)
    const price = validPrice(m.price)
    if (needsPrice && price === null) unpricedCount += 1
    const q = toTokens(m.amount)
    const usd = q * (price ?? 0)

    switch (m.class) {
      case 'buy': {
        held += m.amount
        cost += usd
        boughtQuantity += m.amount
        boughtUsd += usd
        break
      }
      case 'transferIn': {
        // Transfer in: as a buy, but not counted in total bought.
        held += m.amount
        cost += usd
        break
      }
      case 'reward': {
        // Reward: cost 0.
        held += m.amount
        break
      }
      case 'deposit': {
        deposited += m.amount
        break
      }
      case 'withdraw': {
        const w = m.amount < deposited ? m.amount : deposited
        deposited -= w
        const excess = m.amount - w
        // The excess counts as a reward: cost 0.
        held += excess
        break
      }
      case 'sell':
      case 'transferOut': {
        // Oversell clamp: only the part covered by `held - deposited` carries cost; the
        // excess leaves at average cost 0, so all its proceeds are realized (sell only).
        const available = held > deposited ? held - deposited : 0n
        if (m.amount > available) oversell = true
        const covered = m.amount > available ? available : m.amount
        // A sell/transfer that empties the available balance removes the whole remaining
        // cost, so cost is exactly 0 on a full exit (no float dust).
        const removedCost = covered === held ? cost : toTokens(covered) * (cost / toTokens(held))
        if (m.class === 'sell') {
          realized += usd - removedCost
          soldQuantity += m.amount
          soldUsd += usd
        }
        cost -= removedCost
        held -= covered
        break
      }
    }

    rows.push({
      timestamp: m.timestamp,
      hash: m.hash,
      class: m.class,
      amount: m.amount,
      price,
      usdValue: price === null ? null : usd,
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
      deposited,
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
      balanceMismatch: held - deposited !== input.onchainBalance,
    },
    rows,
  }
}
