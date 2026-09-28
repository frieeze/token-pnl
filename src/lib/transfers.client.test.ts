import { describe, expect, it, vi } from 'vitest'

// Verifies the module-level lazy client in transfers.ts is created once and reused,
// rather than once per call. Mocking `viem` here (isolated to this file) lets us count
// `createPublicClient` invocations without making a real network call: the stub client's
// `readContract` rejects immediately.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: vi.fn().mockRejectedValue(new Error('no network in test')),
    })),
  }
})

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
const WALLET = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // some wallet

function noTransfersResponse() {
  return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) }
}

describe('default viem client', () => {
  it('is created once and reused across calls when no client is injected', async () => {
    const { createPublicClient } = await import('viem')
    const { fetchTransfers } = await import('./transfers')

    const fetchMock1 = vi.fn().mockResolvedValueOnce(noTransfersResponse())
    const fetchMock2 = vi.fn().mockResolvedValueOnce(noTransfersResponse())

    await fetchTransfers(TOKEN, [WALLET], { fetch: fetchMock1 })
    await fetchTransfers(TOKEN, [WALLET], { fetch: fetchMock2 })

    expect(createPublicClient).toHaveBeenCalledTimes(1)
  })
})
