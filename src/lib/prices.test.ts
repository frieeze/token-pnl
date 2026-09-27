import { describe, expect, it, vi } from 'vitest'
import { fetchCurrentPrice, fetchHistoricalPrices } from './prices'

// Same live-test switch as transfers.test.ts; `process` isn't in tsconfig.app.json's `types`.
declare const process: { env: Record<string, string | undefined> }

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933' as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchHistoricalPrices', () => {
  it('returns the price DefiLlama reports for a timestamp', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('batchHistorical')
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [{ timestamp: 1727395197, price: 0.00000951, confidence: 0.99 }],
          },
        },
      })
    })

    const result = await fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })

    expect(result.get(1727395200)).toBe(0.00000951)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a timestamp DefiLlama has no data for to null', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: { symbol: 'PEPE', prices: [] },
        },
      }),
    )

    const result = await fetchHistoricalPrices(TOKEN, [1000000000], { fetch: fetchMock })

    expect(result.get(1000000000)).toBeNull()
  })

  it('maps only the timestamps DefiLlama actually priced, leaving the rest null', async () => {
    // batchHistorical preserves request order but omits unmatched entries
    // rather than null-padding them; the module must re-align by position.
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [
              { timestamp: 1700000099, price: 0.00000116, confidence: 0.99 },
              { timestamp: 1700086499, price: 0.00000124, confidence: 0.99 },
            ],
          },
        },
      }),
    )

    const result = await fetchHistoricalPrices(TOKEN, [1600000000, 1700000000, 1700086400], {
      fetch: fetchMock,
    })

    expect(result.get(1600000000)).toBeNull()
    expect(result.get(1700000000)).toBe(0.00000116)
    expect(result.get(1700086400)).toBe(0.00000124)
  })

  it('deduplicates timestamps before calling the API', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const coinsParam = new URL(String(url)).searchParams.get('coins')!
      const coins = JSON.parse(coinsParam) as Record<string, number[]>
      expect(coins[`ethereum:${TOKEN}`]).toEqual([1727395200])
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [{ timestamp: 1727395200, price: 0.00000951, confidence: 0.99 }],
          },
        },
      })
    })

    const result = await fetchHistoricalPrices(
      TOKEN,
      [1727395200, 1727395200, 1727395200],
      { fetch: fetchMock },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.size).toBe(1)
    expect(result.get(1727395200)).toBe(0.00000951)
  })

  it('retries once on a 429 and succeeds on the second attempt', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetchMock = vi.fn(async () => {
        calls++
        if (calls === 1) return jsonResponse({ error: 'rate limited' }, 429)
        return jsonResponse({
          coins: {
            [`ethereum:${TOKEN}`]: {
              symbol: 'PEPE',
              prices: [{ timestamp: 1727395200, price: 0.00000951, confidence: 0.99 }],
            },
          },
        })
      })

      const promise = fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(calls).toBe(2)
      expect(result.get(1727395200)).toBe(0.00000951)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries once on a 500 and gives up with an error if it fails again', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, 500))

      const promise = fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })
      // Attach a rejection handler immediately so the unresolved promise
      // doesn't trigger an unhandled-rejection warning while timers advance.
      const assertion = expect(promise).rejects.toThrow()
      await vi.runAllTimersAsync()
      await assertion

      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports progress as chunks complete', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [{ timestamp: 1727395200, price: 0.00000951, confidence: 0.99 }],
          },
        },
      }),
    )
    const onProgress = vi.fn()

    await fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock, onProgress })

    expect(onProgress).toHaveBeenCalledWith(0, 1)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })

  it('chunks large timestamp sets into multiple batchHistorical calls', async () => {
    const timestamps = Array.from({ length: 1001 }, (_, i) => 1_600_000_000 + i)
    const chunkSizes: number[] = []

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const coinsParam = new URL(String(url)).searchParams.get('coins')!
      const chunk = JSON.parse(coinsParam)[`ethereum:${TOKEN}`] as number[]
      chunkSizes.push(chunk.length)
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: chunk.map((timestamp) => ({
              timestamp,
              price: timestamp / 1e12,
              confidence: 0.99,
            })),
          },
        },
      })
    })

    const result = await fetchHistoricalPrices(TOKEN, timestamps, { fetch: fetchMock })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(chunkSizes.sort((a, b) => b - a)).toEqual([500, 500, 1])
    for (const ts of timestamps) {
      expect(result.get(ts)).toBeCloseTo(ts / 1e12)
    }
  })

  it('never runs more concurrent requests than the concurrency option', async () => {
    const timestamps = Array.from({ length: 2001 }, (_, i) => 1_600_000_000 + i) // 5 chunks
    const concurrency = 3
    let inFlight = 0
    let maxInFlight = 0

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--

      const coinsParam = new URL(String(url)).searchParams.get('coins')!
      const chunk = JSON.parse(coinsParam)[`ethereum:${TOKEN}`] as number[]
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: chunk.map((timestamp) => ({
              timestamp,
              price: timestamp / 1e12,
              confidence: 0.99,
            })),
          },
        },
      })
    })

    await fetchHistoricalPrices(TOKEN, timestamps, { fetch: fetchMock, concurrency })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(concurrency)
  })

  it('maps each timestamp to its correct price regardless of input order', async () => {
    const shuffled = [1700086400, 1600000000, 1700000000]
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const coinsParam = new URL(String(url)).searchParams.get('coins')!
      const chunk = JSON.parse(coinsParam)[`ethereum:${TOKEN}`] as number[]
      // The module must sort timestamps before requesting them, regardless
      // of the order they were passed in.
      expect(chunk).toEqual([...chunk].sort((a, b) => a - b))
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [
              { timestamp: 1600000099, price: 0.1, confidence: 0.99 },
              { timestamp: 1700000099, price: 0.2, confidence: 0.99 },
              { timestamp: 1700086499, price: 0.3, confidence: 0.99 },
            ],
          },
        },
      })
    })

    const result = await fetchHistoricalPrices(TOKEN, shuffled, { fetch: fetchMock })

    expect(result.get(1600000000)).toBe(0.1)
    expect(result.get(1700000000)).toBe(0.2)
    expect(result.get(1700086400)).toBe(0.3)
  })

  it('passes an AbortSignal derived from timeoutMs to fetch', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [{ timestamp: 1727395200, price: 0.00000951, confidence: 0.99 }],
          },
        },
      })
    })

    await fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock, timeoutMs: 50 })

    expect(fetchMock).toHaveBeenCalled()
  })

  it('retries once when a request times out or errors, then succeeds', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetchMock = vi.fn(async () => {
        calls++
        if (calls === 1) throw new DOMException('The operation timed out.', 'TimeoutError')
        return jsonResponse({
          coins: {
            [`ethereum:${TOKEN}`]: {
              symbol: 'PEPE',
              prices: [{ timestamp: 1727395200, price: 0.00000951, confidence: 0.99 }],
            },
          },
        })
      })

      const promise = fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(calls).toBe(2)
      expect(result.get(1727395200)).toBe(0.00000951)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up with a clear error if a request times out twice', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      })

      const promise = fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })
      const assertion = expect(promise).rejects.toThrow(/DefiLlama/)
      await vi.runAllTimersAsync()
      await assertion

      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops starting new chunks once one has failed for good', async () => {
    vi.useFakeTimers()
    try {
      const timestamps = Array.from({ length: 1001 }, (_, i) => 1_600_000_000 + i) // 3 chunks
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, 500))

      const promise = fetchHistoricalPrices(TOKEN, timestamps, {
        fetch: fetchMock,
        concurrency: 1,
      })
      const assertion = expect(promise).rejects.toThrow()
      await vi.runAllTimersAsync()
      await assertion

      // Only the first chunk's requests (initial attempt + retry) are made;
      // the worker never starts chunk 2 or 3.
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws a clear error if DefiLlama returns more prices than requested for a chunk', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'PEPE',
            prices: [
              { timestamp: 1727395100, price: 0.1, confidence: 0.99 },
              { timestamp: 1727395200, price: 0.2, confidence: 0.99 },
            ],
          },
        },
      }),
    )

    await expect(fetchHistoricalPrices(TOKEN, [1727395200], { fetch: fetchMock })).rejects.toThrow(
      /returned 2 prices/i,
    )
  })
})

describe('fetchCurrentPrice', () => {
  it('returns the current price DefiLlama reports', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://coins.llama.fi/prices/current/ethereum:${TOKEN}`)
      return jsonResponse({
        coins: {
          [`ethereum:${TOKEN}`]: { symbol: 'PEPE', price: 0.0000043, confidence: 0.99 },
        },
      })
    })

    const price = await fetchCurrentPrice(TOKEN, { fetch: fetchMock })

    expect(price).toBe(0.0000043)
  })

  it('returns null when DefiLlama has no current price for the token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ coins: {} }))

    const price = await fetchCurrentPrice(TOKEN, { fetch: fetchMock })

    expect(price).toBeNull()
  })
})

// Opt-in live test against the real DefiLlama API. Run with:
//   LIVE=1 npm test -- src/lib/prices.test.ts
describe.skipIf(!process.env.LIVE)('fetchHistoricalPrices (live)', () => {
  it('prices PEPE at 1727395200 close to $0.0000095', async () => {
    const result = await fetchHistoricalPrices(TOKEN, [1727395200])
    const price = result.get(1727395200)

    expect(price).not.toBeNull()
    expect(price).toBeCloseTo(0.0000095, 6)
  })
})
