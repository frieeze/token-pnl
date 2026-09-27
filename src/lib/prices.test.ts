import { describe, expect, it, vi } from 'vitest'
import { fetchCurrentPrice, fetchHistoricalPrices } from './prices'

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
describe.skipIf(!import.meta.env.LIVE)('fetchHistoricalPrices (live)', () => {
  it('prices PEPE at 1727395200 close to $0.0000095', async () => {
    const result = await fetchHistoricalPrices(TOKEN, [1727395200])
    const price = result.get(1727395200)

    expect(price).not.toBeNull()
    expect(price).toBeCloseTo(0.0000095, 6)
  })
})
