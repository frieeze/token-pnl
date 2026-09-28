import { describe, expect, it } from 'vitest'
import {
  allowedClasses,
  applyOverrides,
  keyOf,
  parseOverridesParam,
  serializeOverridesParam,
  type Overrides,
} from './overrides'
import type { MovementClass } from './pnl'

const HASH_A = `0x${'a'.repeat(64)}` as const
const HASH_B = `0x${'b'.repeat(64)}` as const

describe('allowedClasses', () => {
  it('lists the in-direction classes for an in class', () => {
    expect(allowedClasses('buy')).toEqual(['buy', 'withdraw', 'reward', 'transferIn'])
    expect(allowedClasses('withdraw')).toEqual(['buy', 'withdraw', 'reward', 'transferIn'])
  })

  it('lists the out-direction classes for an out class', () => {
    expect(allowedClasses('sell')).toEqual(['sell', 'deposit', 'transferOut'])
    expect(allowedClasses('deposit')).toEqual(['sell', 'deposit', 'transferOut'])
  })
})

describe('keyOf', () => {
  it('keys a movement by tx hash and its index among same-hash movements', () => {
    expect(keyOf(HASH_A, 0)).toBe(keyOf(HASH_A, 0))
    expect(keyOf(HASH_A, 0)).not.toBe(keyOf(HASH_A, 1))
    expect(keyOf(HASH_A, 0)).not.toBe(keyOf(HASH_B, 0))
  })
})

describe('parseOverridesParam / serializeOverridesParam', () => {
  it('round-trips a set of overrides', () => {
    const overrides: Overrides = new Map([
      [keyOf(HASH_A, 0), 'withdraw'],
      [keyOf(HASH_A, 1), 'deposit'],
    ])
    const serialized = serializeOverridesParam(overrides)
    expect(parseOverridesParam(serialized)).toEqual(overrides)
  })

  it('parses an empty or null param as no overrides', () => {
    expect(parseOverridesParam(null)).toEqual(new Map())
    expect(parseOverridesParam('')).toEqual(new Map())
  })

  it('ignores malformed entries instead of throwing', () => {
    // missing class, unknown class, missing index, garbage entry
    const raw = [`${HASH_A}:0:`, `${HASH_A}:1:notaclass`, `${HASH_A}:x:buy`, 'garbage', `${HASH_B}:0:sell`].join(',')
    expect(parseOverridesParam(raw)).toEqual(new Map([[keyOf(HASH_B, 0), 'sell']]))
  })
})

describe('applyOverrides', () => {
  const movements = [
    { hash: HASH_A, class: 'buy' as MovementClass },
    { hash: HASH_A, class: 'sell' as MovementClass },
    { hash: HASH_B, class: 'reward' as MovementClass },
  ]

  it('keeps the original class when there is no override', () => {
    expect(applyOverrides(movements, new Map())).toEqual(['buy', 'sell', 'reward'])
  })

  it('applies a same-direction override, keyed by hash + index within that hash', () => {
    const overrides: Overrides = new Map([[keyOf(HASH_A, 0), 'withdraw']])
    expect(applyOverrides(movements, overrides)).toEqual(['withdraw', 'sell', 'reward'])
  })

  it('ignores a wrong-direction override (malformed/stale URL) instead of applying it', () => {
    // 'buy' is in-direction; 'sell' is out-direction, so this override must be ignored.
    const overrides: Overrides = new Map([[keyOf(HASH_A, 0), 'sell']])
    expect(applyOverrides(movements, overrides)).toEqual(['buy', 'sell', 'reward'])
  })

  it('ignores an override for a key that does not match any movement', () => {
    const overrides: Overrides = new Map([[keyOf(HASH_B, 5), 'deposit']])
    expect(applyOverrides(movements, overrides)).toEqual(['buy', 'sell', 'reward'])
  })

  it('distinguishes the second movement of the same tx from the first', () => {
    const overrides: Overrides = new Map([[keyOf(HASH_A, 1), 'deposit']])
    expect(applyOverrides(movements, overrides)).toEqual(['buy', 'deposit', 'reward'])
  })
})
