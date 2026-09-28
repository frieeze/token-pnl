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

/** Keys a movement by tx hash plus its index among this token's movements in that tx. */
export function keyOf(hash: Hash | string, indexInTx: number): string {
  return `${hash}:${indexInTx}`
}

const CLASS_SET = new Set<string>([...IN_CLASSES, ...OUT_CLASSES])
const isMovementClass = (s: string): s is MovementClass => CLASS_SET.has(s)

/** Parses the URL override param. Malformed or unknown entries are dropped, never thrown. */
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
    overrides.set(keyOf(hash, Number(indexStr)), cls)
  }
  return overrides
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
  const seen = new Map<string, number>()
  return movements.map((m) => {
    const index = seen.get(m.hash as string) ?? 0
    seen.set(m.hash as string, index + 1)
    const override = overrides.get(keyOf(m.hash, index))
    return override && allowedClasses(m.class).includes(override) ? override : m.class
  })
}
