// Caches each wallet's Blockscout transfer history, and each tx's classifier data, in
// localStorage (or an injected fake), so a page reload only fetches what's new. Used from
// `fetchTransfers` and `classifyMovements`.
//
// Every read and write is wrapped in try/catch: a missing, corrupt or wrong-version entry just
// means a full fetch, and a failed write (e.g. quota) means the app runs uncached, as before.

import { isAddress } from 'viem'

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

/** One cached log: only the fields `classify.ts`'s rules read. */
export interface CachedTxLog {
  address: string
  topics: readonly string[]
  data: string
}

/** One cached tx: only the fields the classifier reads off a transaction and its receipt. */
export interface CachedTx {
  from: string
  value: string // decimal string (bigint)
  logs: CachedTxLog[]
}

interface TxCacheEntry {
  v: number
  from: string
  value: string
  logs: CachedTxLog[]
}

/** The slice of `Storage` the cache needs, so tests (and callers) can inject a fake. */
export type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>

/** `localStorage` when available (a browser, not in private mode); `undefined` otherwise. */
export function defaultCacheStorage(): CacheStorage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

const SCHEMA_VERSION = 1
const PREFIX = 'token-pnl:transfers:'
const TX_SCHEMA_VERSION = 1
const TX_PREFIX = 'token-pnl:tx:'

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
      evictOtherEntries(storage, key, PREFIX)
      storage.setItem(key, value)
    } catch {
      // still failing: skip caching, the app works the same as without storage
    }
  }
}

function txCacheKey(hash: string): string {
  return `${TX_PREFIX}${hash.toLowerCase()}`
}

/** Cached tx data for `hash`, or null if there's none, it's corrupt, or the wrong schema version. */
export function readTxCache(storage: CacheStorage | undefined, hash: string): CachedTx | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(txCacheKey(hash))
    if (!raw) return null
    const entry = JSON.parse(raw) as TxCacheEntry
    if (entry.v !== TX_SCHEMA_VERSION || !Array.isArray(entry.logs)) return null
    // The caller turns these into an Address and a bigint: a malformed entry must mean a refetch, not a throw.
    if (typeof entry.value !== 'string' || !/^\d+$/.test(entry.value)) return null
    if (typeof entry.from !== 'string' || !isAddress(entry.from, { strict: false })) return null
    return { from: entry.from, value: entry.value, logs: entry.logs }
  } catch {
    return null
  }
}

/**
 * Saves `tx` for `hash`. On a write failure (e.g. quota), every other `token-pnl:tx:` entry
 * (not `token-pnl:transfers:` ones) is removed and the write is retried once; if it still
 * fails, caching is skipped for this call.
 */
export function writeTxCache(storage: CacheStorage | undefined, hash: string, tx: CachedTx): void {
  if (!storage) return
  const key = txCacheKey(hash)
  const value = JSON.stringify({ v: TX_SCHEMA_VERSION, ...tx } satisfies TxCacheEntry)
  try {
    storage.setItem(key, value)
  } catch {
    try {
      evictOtherEntries(storage, key, TX_PREFIX)
      storage.setItem(key, value)
    } catch {
      // still failing: skip caching, the app works the same as without storage
    }
  }
}

function evictOtherEntries(storage: CacheStorage, keep: string, prefix: string): void {
  const len = storage.length ?? 0
  const keys: string[] = []
  for (let i = 0; i < len; i++) {
    const k = storage.key?.(i)
    if (k && k.startsWith(prefix) && k !== keep) keys.push(k)
  }
  for (const k of keys) storage.removeItem(k)
}
