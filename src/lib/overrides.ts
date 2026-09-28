// Manual class overrides (issue #16): keying, URL param parsing/serialising, and applying
// overrides to a movement's class. Pure module: no network, no Svelte, no clock.

import type { Hash } from 'viem'
import type { MovementClass } from './pnl'

const IN_CLASSES: readonly MovementClass[] = ['buy', 'withdraw', 'reward', 'transferIn']
const OUT_CLASSES: readonly MovementClass[] = ['sell', 'deposit', 'transferOut']

/** The classes of the same direction as `cls` (what the override control may offer). */
export function allowedClasses(cls: MovementClass): readonly MovementClass[] {
  return IN_CLASSES.includes(cls) ? IN_CLASSES : OUT_CLASSES
}

/** Movement key → overridden class. Keys are produced by `keyOf`. */
export type Overrides = Map<string, MovementClass>

/**
 * Keys a movement by tx hash plus its index among this token's movements in that tx.
 * The index relies on Blockscout returning a tx's transfers in the same order every time (it gives no log index).
 */
export function keyOf(hash: Hash | string, indexInTx: number): string {
  return `${hash}:${indexInTx}`
}

const CLASS_SET = new Set<string>([...IN_CLASSES, ...OUT_CLASSES])
const isMovementClass = (s: string): s is MovementClass => CLASS_SET.has(s)

/**
 * Parses the URL override param. Malformed or unknown entries are dropped, never thrown.
 * A key given twice keeps its last entry. Hashes are lowercased to match Blockscout's.
 */
export function parseOverridesParam(param: string | null): Overrides {
  const overrides: Overrides = new Map()
  if (!param) return overrides
  for (const entry of param.split(',')) {
    const parts = entry.split(':')
    if (parts.length !== 3) continue
    const [hash, indexStr, cls] = parts as [string, string, string]
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue
    if (!/^\d+$/.test(indexStr)) continue
    if (!isMovementClass(cls)) continue
    overrides.set(keyOf(hash.toLowerCase(), Number(indexStr)), cls)
  }
  return overrides
}

/** The key of each movement, in order (see `keyOf`). */
export function keysOf(movements: readonly { hash: Hash | string }[]): string[] {
  const seen = new Map<string, number>()
  return movements.map((m) => {
    const index = seen.get(m.hash) ?? 0
    seen.set(m.hash, index + 1)
    return keyOf(m.hash, index)
  })
}

/** Sets `key` to `cls`, or drops the override when `cls` is the movement's own class. */
export function withOverride(overrides: Overrides, key: string, cls: MovementClass, original: MovementClass): Overrides {
  const next = new Map(overrides)
  if (cls === original) next.delete(key)
  else next.set(key, cls)
  return next
}

/** `search` with its `overrides` param set to `overrides`, or removed when there are none. */
export function withOverridesParam(search: string | URLSearchParams, overrides: Overrides): URLSearchParams {
  const next = new URLSearchParams(search)
  const serialized = serializeOverridesParam(overrides)
  if (serialized) next.set('overrides', serialized)
  else next.delete('overrides')
  return next
}

/** Serialises overrides to the URL param format `parseOverridesParam` reads. */
export function serializeOverridesParam(overrides: Overrides): string {
  return [...overrides].map(([key, cls]) => `${key}:${cls}`).join(',')
}

/**
 * The effective class of each movement: the override when present and valid for that
 * movement's direction, otherwise its original class. A stale/malformed override
 * (unknown key, wrong-direction class) is ignored rather than applied.
 */
export function applyOverrides(
  movements: readonly { hash: Hash | string; class: MovementClass }[],
  overrides: Overrides,
): MovementClass[] {
  const keys = keysOf(movements)
  return movements.map((m, i) => {
    const override = overrides.get(keys[i]!)
    return override && allowedClasses(m.class).includes(override) ? override : m.class
  })
}
