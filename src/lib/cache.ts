// Caches each wallet's Blockscout transfer history in localStorage (or an injected fake), so a
// page reload only fetches what changed since the last visit. Used from `fetchTransfers`.
//
// Every read and write is wrapped in try/catch: a missing, corrupt or wrong-version entry just
// means a full fetch, and a failed write (e.g. quota) means the app runs uncached, as before.

/** One cached row: only the fields the app reads off a Blockscout `tokentx` row. */
export interface CachedRow {
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

interface CacheEntry {
  v: number
  rows: CachedRow[]
}

/** The slice of `Storage` the cache needs, so tests (and callers) can inject a fake. */
export type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>

const SCHEMA_VERSION = 1
const PREFIX = 'token-pnl:transfers:'

function cacheKey(token: string, wallet: string): string {
  return `${PREFIX}${token.toLowerCase()}:${wallet.toLowerCase()}`
}

/** Cached rows for (token, wallet), or null if there's none, it's corrupt, or the wrong schema version. */
export function readCache(storage: CacheStorage | undefined, token: string, wallet: string): CachedRow[] | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(cacheKey(token, wallet))
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.v !== SCHEMA_VERSION || !Array.isArray(entry.rows)) return null
    return entry.rows
  } catch {
    return null
  }
}

/**
 * Saves `rows` for (token, wallet). On a write failure (e.g. quota), every other
 * `token-pnl:transfers:` entry is removed and the write is retried once; if it still fails,
 * caching is skipped for this call.
 */
export function writeCache(storage: CacheStorage | undefined, token: string, wallet: string, rows: CachedRow[]): void {
  if (!storage) return
  const key = cacheKey(token, wallet)
  // Blockscout rows carry ~20 fields (calldata included); keep only ours so the quota lasts.
  const slim = rows.map(({ hash, blockNumber, transactionIndex, timeStamp, from, to, value, tokenSymbol, tokenDecimal }) => ({
    hash, blockNumber, transactionIndex, timeStamp, from, to, value, tokenSymbol, tokenDecimal,
  }))
  const value = JSON.stringify({ v: SCHEMA_VERSION, rows: slim } satisfies CacheEntry)
  try {
    storage.setItem(key, value)
  } catch {
    try {
      evictOtherEntries(storage, key)
      storage.setItem(key, value)
    } catch {
      // still failing: skip caching, the app works the same as without storage
    }
  }
}

function evictOtherEntries(storage: CacheStorage, keep: string): void {
  const len = storage.length ?? 0
  const keys: string[] = []
  for (let i = 0; i < len; i++) {
    const k = storage.key?.(i)
    if (k && k.startsWith(PREFIX) && k !== keep) keys.push(k)
  }
  for (const k of keys) storage.removeItem(k)
}
