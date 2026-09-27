import { BaseError, HttpRequestError, formatUnits } from 'viem'

// Display helpers for the page. Missing values render as an em dash, never as 0.

const MISSING = '—'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
// Sub-dollar token prices (e.g. $0.0000012) need significant digits, not cents.
const usdSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 })

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING
  return (value !== 0 && Math.abs(value) < 1 ? usdSmall : usd).format(value)
}

const FRACTION_DIGITS = 6

/** Raw token units → "1,234.567891": exact (string math, no float), fraction cut to 6 digits. */
export function formatAmount(raw: bigint, decimals: number): string {
  const [int = '0', frac = ''] = formatUnits(raw, decimals).split('.')
  const cut = frac.slice(0, FRACTION_DIGITS).replace(/0+$/, '')
  const out = BigInt(int).toLocaleString('en-US') + (cut ? `.${cut}` : '')
  return out === '0' && raw !== 0n ? `<0.${'0'.repeat(FRACTION_DIGITS - 1)}1` : out
}

/** Unix seconds → "2023-11-14 22:13 UTC". */
export function formatDate(timestamp: number): string {
  return `${new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// Blockscout/DefiLlama put the HTTP status in the message ("failed: 429 …", "HTTP 429");
// Blockscout also signals its IP limit in a normal JSON body ("Too many requests").
const RATE_LIMIT = /(?:^|\s)429\b|too many requests/i

/** A message for the page: a clear "rate-limited" for HTTP 429, otherwise the error's own message. */
export function errorMessage(err: unknown): string {
  const message = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err)
  if ((err instanceof HttpRequestError && err.status === 429) || RATE_LIMIT.test(message)) {
    return 'Rate-limited by a data provider (too many requests). Try again later.'
  }
  return message
}
