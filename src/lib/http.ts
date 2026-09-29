// Shared retrying fetch, used for both Blockscout and DefiLlama requests.
//
// Up to 3 retries with 1s/2s/4s backoff, or the response's `Retry-After` header (seconds)
// when present, capped at 10s. Retries on 429, 5xx, timeout and network errors; any other
// status fails at once, as before.

const MAX_RETRIES = 3
const BACKOFF_MS = [1000, 2000, 4000]
const MAX_RETRY_AFTER_MS = 10_000

export interface FetchWithRetryOptions {
  timeoutMs: number
  /** Named in the error thrown after the last retry, e.g. "Blockscout", "DefiLlama". */
  label: string
  /** Injectable so tests don't really wait; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
}

/** A fetch attempt that failed; `retryable` decides whether the caller sleeps and tries again. */
class FetchFailure extends Error {
  retryable: boolean
  retryAfterMs?: number

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message)
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

export async function fetchWithRetry(
  url: string,
  doFetch: typeof fetch,
  { timeoutMs, label, sleep = defaultSleep }: FetchWithRetryOptions,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptFetch(url, doFetch, timeoutMs)
    } catch (err) {
      if (!(err instanceof FetchFailure)) throw err
      if (!err.retryable || attempt === MAX_RETRIES) {
        throw new Error(`${label} request failed: ${err.message} (${url})`)
      }
      await sleep(Math.min(err.retryAfterMs ?? BACKOFF_MS[attempt]!, MAX_RETRY_AFTER_MS))
    }
  }
}

async function attemptFetch(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<Response> {
  let res: Response
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown error'
    throw new FetchFailure(`network error or timeout (${name})`, true)
  }
  if (res.ok) return res

  const detail = await describeErrorBody(res)
  const retryable = res.status === 429 || res.status >= 500
  throw new FetchFailure(`${res.status} ${detail}`, retryable, retryable ? parseRetryAfterMs(res) : undefined)
}

/** Blockscout/DefiLlama error bodies are usually JSON with a `message` field; fall back to statusText. */
async function describeErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.message === 'string' && body.message) return body.message
  } catch {
    // body wasn't JSON: fall back to statusText
  }
  return res.statusText
}

function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers?.get?.('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
