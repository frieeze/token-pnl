// USD prices from the DefiLlama coins API (Ethereum only).
//
// DefiLlama findings (checked live 2026-09-27):
// - `/prices/historical/{ts}/{coins}` and `/prices/current/{coins}` return
//   `{"coins":{}}` (an empty object, not an error) when the coin is unknown at
//   that timestamp, e.g. before the token existed. That is our "unpriced" (null).
// - `/batchHistorical?coins={"ethereum:0x..":[ts,...]}` prices many timestamps for
//   one token in a single call, and is reliable and CORS-enabled (echoes the
//   request's Origin, same as the single-timestamp endpoint). It is used here
//   instead of per-timestamp calls to cut the number of requests dramatically.
//   The response's `prices` array preserves the request order but *omits*
//   entries with no match at all (rather than nulling them), so timestamps are
//   matched back positionally (see `matchClosestPrices`).
// - The free tier caps request URLs at 9000 characters (confirmed via a live
//   414 "URL too long" response), so timestamps are chunked to stay well under
//   that limit.
// - `confidence` (0-1) reflects how close the matched data point is to the
//   requested timestamp; DefiLlama already picks the closest point within its
//   search width, so we surface the price as-is and don't second-guess it.
// - We rely on DefiLlama's default `searchWidth` (not passed explicitly), per
//   the issue's guidance, since live tests showed no problem with it.

import { fetchWithRetry } from './http'

const BATCH_HISTORICAL_URL = 'https://coins.llama.fi/batchHistorical'
const CURRENT_PRICE_URL = 'https://coins.llama.fi/prices/current'

// Stays well under DefiLlama's free-tier 9000-char URL limit for batchHistorical.
const TIMESTAMPS_PER_CHUNK = 500
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 15_000

export interface FetchHistoricalPricesOpts {
  fetch?: typeof fetch
  onProgress?: (done: number, total: number) => void
  concurrency?: number
  timeoutMs?: number
}

export interface FetchCurrentPriceOpts {
  fetch?: typeof fetch
  timeoutMs?: number
}

interface BatchHistoricalPrice {
  timestamp: number
  price: number
}

/**
 * Returns a map from each requested unix-seconds timestamp to its USD price,
 * or null if DefiLlama has no price for the token at that timestamp.
 *
 * Timestamps are deduplicated, fetched via DefiLlama's `batchHistorical`
 * endpoint in chunks with limited concurrency, and each chunk retries (see
 * `http.ts`) on a 429, 5xx, timeout or network error. If retries are
 * exhausted, the returned promise rejects (see the module comment above: a
 * fetch failure is a distinct, transient problem from "DefiLlama has no
 * price data", which is `null`).
 */
export async function fetchHistoricalPrices(
  token: `0x${string}`,
  timestamps: number[],
  opts: FetchHistoricalPricesOpts = {},
): Promise<Map<number, number | null>> {
  const doFetch = opts.fetch ?? fetch
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const unique = Array.from(new Set(timestamps)).sort((a, b) => a - b)

  const result = new Map<number, number | null>()
  const total = unique.length
  opts.onProgress?.(0, total)
  if (total === 0) return result

  const chunks: number[][] = []
  for (let i = 0; i < unique.length; i += TIMESTAMPS_PER_CHUNK) {
    chunks.push(unique.slice(i, i + TIMESTAMPS_PER_CHUNK))
  }

  let done = 0
  let nextChunkIndex = 0
  // Once a chunk has failed for good, workers stop starting new chunks.
  // In-flight chunks are allowed to finish, but their results are discarded.
  let failure: Error | null = null

  async function worker(): Promise<void> {
    while (nextChunkIndex < chunks.length && !failure) {
      const chunk = chunks[nextChunkIndex++]!
      let apiPrices: BatchHistoricalPrice[]
      try {
        apiPrices = await fetchBatchHistoricalChunk(token, chunk, doFetch, timeoutMs)
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err))
        return
      }
      if (failure) return

      for (const [ts, price] of matchClosestPrices(chunk, apiPrices)) {
        result.set(ts, price)
      }
      done += chunk.length
      opts.onProgress?.(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))

  if (failure) throw failure

  return result
}

/** Returns DefiLlama's current USD price for the token, or null if unpriced. */
export async function fetchCurrentPrice(
  token: `0x${string}`,
  opts: FetchCurrentPriceOpts = {},
): Promise<number | null> {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const key = coinKey(token)
  const url = `${CURRENT_PRICE_URL}/${key}`

  const res = await fetchWithRetry(url, doFetch, { timeoutMs, label: 'DefiLlama' })
  const data = (await res.json()) as { coins?: Record<string, { price: number }> }
  return data.coins?.[key]?.price ?? null
}

/** Builds the `chain:address` key DefiLlama's coins API expects (Ethereum only). */
function coinKey(token: `0x${string}`): string {
  return `ethereum:${token}`
}

async function fetchBatchHistoricalChunk(
  token: `0x${string}`,
  chunk: number[],
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<BatchHistoricalPrice[]> {
  const key = coinKey(token)
  const coins = JSON.stringify({ [key]: chunk })
  const url = `${BATCH_HISTORICAL_URL}?coins=${encodeURIComponent(coins)}`

  const res = await fetchWithRetry(url, doFetch, { timeoutMs, label: 'DefiLlama' })
  const data = (await res.json()) as {
    coins?: Record<string, { prices?: BatchHistoricalPrice[] }>
  }
  const prices = data.coins?.[key]?.prices ?? []
  if (prices.length > chunk.length) {
    throw new Error(
      `DefiLlama returned ${prices.length} prices for a chunk of ${chunk.length} requested timestamps (${url})`,
    )
  }
  return prices
}

/**
 * Matches DefiLlama's `batchHistorical` results back to the requested
 * timestamps. The API returns results in request order but drops entries it
 * has no data for (it does not null-pad), so this walks both arrays in
 * lock-step: a result is assigned to the current requested timestamp unless
 * it is actually closer to the *next* one, in which case the current
 * timestamp is unpriced (null) and the result is held for the next slot.
 * `requestedTimestamps` must be sorted ascending, matching what we send.
 */
function matchClosestPrices(
  requestedTimestamps: number[],
  apiPrices: BatchHistoricalPrice[],
): Array<[number, number | null]> {
  const pairs: Array<[number, number | null]> = []
  let j = 0

  for (let i = 0; i < requestedTimestamps.length; i++) {
    const requested = requestedTimestamps[i]!
    const candidate = apiPrices[j]

    if (!candidate) {
      pairs.push([requested, null])
      continue
    }

    const next = requestedTimestamps[i + 1]
    const closerToNext =
      next !== undefined &&
      Math.abs(candidate.timestamp - next) < Math.abs(candidate.timestamp - requested)

    if (closerToNext) {
      pairs.push([requested, null])
    } else {
      pairs.push([requested, candidate.price])
      j++
    }
  }

  return pairs
}

