import { describe, expect, it, vi } from 'vitest'
import { fetchWithRetry } from './http'

function okResponse(): Response {
  return new Response('{}', { status: 200 })
}

describe('fetchWithRetry', () => {
  it('returns the response on the first successful attempt', async () => {
    const fetchMock = vi.fn(async () => okResponse())

    const res = await fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test' })

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries after a 429 and succeeds, waiting about 1s before the retry', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return calls === 1 ? new Response('{}', { status: 429 }) : okResponse()
    })
    const sleep = vi.fn(async () => {})

    const res = await fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('honors a Retry-After header (seconds) instead of the default backoff', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '3' } })
        : okResponse()
    })
    const sleep = vi.fn(async () => {})

    await fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })

    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('caps a Retry-After header at 10s', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
        : okResponse()
    })
    const sleep = vi.fn(async () => {})

    await fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })

    expect(sleep).toHaveBeenCalledWith(10_000)
  })

  it('retries with 1s/2s/4s backoff and gives up after 3 retries, with the status in the message', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }))
    const sleep = vi.fn(async (_ms: number) => {})

    await expect(fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })).rejects.toThrow(
      /Test request failed.*503/,
    )

    expect(fetchMock).toHaveBeenCalledTimes(4) // initial + 3 retries
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000])
  })

  it('retries a network error/timeout and succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) throw new DOMException('The operation timed out.', 'TimeoutError')
      return okResponse()
    })
    const sleep = vi.fn(async () => {})

    const res = await fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails immediately on a non-retryable status, without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }))
    const sleep = vi.fn(async () => {})

    await expect(fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Test', sleep })).rejects.toThrow(
      /Test request failed.*404/,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('uses a JSON body message in the error when present', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Too many requests. Slow down.' }), { status: 429 }),
    )
    const sleep = vi.fn(async () => {})

    await expect(fetchWithRetry('https://x', fetchMock, { timeoutMs: 1000, label: 'Blockscout', sleep })).rejects.toThrow(
      /Too many requests\. Slow down\./,
    )
  })
})
