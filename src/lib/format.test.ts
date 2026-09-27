import { describe, expect, it } from 'vitest'
import { HttpRequestError } from 'viem'
import { errorMessage, formatAmount, formatDate, formatUsd } from './format'

describe('formatUsd', () => {
  it('formats dollars with thousands separators and cents', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(-42)).toBe('-$42.00')
  })
  it('keeps significant digits for sub-dollar prices', () => {
    expect(formatUsd(0.000001234567)).toBe('$0.000001235')
  })
  it('shows a dash when the value is missing', () => {
    expect(formatUsd(null)).toBe('—')
  })
})

describe('formatAmount', () => {
  it('converts raw units with the token decimals and groups thousands', () => {
    expect(formatAmount(1234567_500000n, 6)).toBe('1,234,567.5')
  })
  it('keeps 18-decimal amounts past float precision in the integer part', () => {
    expect(formatAmount(123456789012345678901234n * 10n ** 18n, 18)).toBe('123,456,789,012,345,678,901,234')
  })
  it('cuts the fraction to 6 digits', () => {
    expect(formatAmount(1_123456789n, 9)).toBe('1.123456')
  })
  it('does not show a non-zero dust amount as 0', () => {
    expect(formatAmount(1n, 18)).toBe('<0.000001')
    expect(formatAmount(0n, 18)).toBe('0')
  })
})

describe('formatDate', () => {
  it('shows the block time in UTC, to the minute', () => {
    expect(formatDate(1700000000)).toBe('2023-11-14 22:13 UTC')
  })
})

describe('errorMessage', () => {
  const RATE_LIMITED = /rate-limited.*try again later/i

  it('shows the error message', () => {
    expect(errorMessage(new Error('Blockscout request failed: 500 boom'))).toBe('Blockscout request failed: 500 boom')
  })
  it('says rate-limited when an API answered HTTP 429', () => {
    expect(errorMessage(new Error('Blockscout request failed: 429 Too Many Requests'))).toMatch(RATE_LIMITED)
    expect(errorMessage(new Error('DefiLlama request failed after retry: HTTP 429 (https://coins.llama.fi/x)'))).toMatch(RATE_LIMITED)
    expect(errorMessage(new HttpRequestError({ url: 'https://rpc', status: 429 }))).toMatch(RATE_LIMITED)
  })
  it("says rate-limited on Blockscout's in-body rate limit message", () => {
    expect(errorMessage(new Error('Blockscout error: Too many requests. Increase limits now at https://dev.blockscout.com'))).toMatch(RATE_LIMITED)
  })
  it("uses viem's short message rather than its multi-line details", () => {
    expect(errorMessage(new HttpRequestError({ url: 'https://rpc', status: 500 }))).toBe('HTTP request failed.')
  })
  it('does not mistake a 429 inside a URL or address for a rate limit', () => {
    expect(errorMessage(new Error('DefiLlama request failed: 404 https://x/0x4290ab'))).not.toMatch(RATE_LIMITED)
  })
})
