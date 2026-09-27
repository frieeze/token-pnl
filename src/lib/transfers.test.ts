import { describe, expect, it, vi } from 'vitest'
import { balanceOf, fetchTransfers } from './transfers'

// tsconfig.app.json (which type-checks this file via svelte-check) scopes `types` to
// `svelte`/`vite/client` only, so `process` isn't ambiently declared even though
// @types/node is installed. Declare just what we use rather than widen that config.
declare const process: { env: Record<string, string | undefined> }

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
const WALLET = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // some wallet
const OTHER = '0x1111111111111111111111111111111111111111'
const THIRD = '0x2222222222222222222222222222222222222222'

function row(overrides: Record<string, string> = {}) {
  return {
    hash: '0xaaaa000000000000000000000000000000000000000000000000000000aa',
    blockNumber: '100',
    transactionIndex: '1',
    timeStamp: '1700000000',
    from: OTHER,
    to: WALLET,
    value: '1000000',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    ...overrides,
  }
}

function okResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ status: '1', message: 'OK', result }),
  }
}

describe('fetchTransfers', () => {
  it('normalizes a single incoming transfer as a buy', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse([row()]))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
    expect(result.movements).toEqual([
      {
        hash: '0xaaaa000000000000000000000000000000000000000000000000000000aa',
        blockNumber: 100n,
        transactionIndex: 1,
        timestamp: 1700000000,
        direction: 'buy',
        amount: 1000000n,
      },
    ])
  })

  it('normalizes an outgoing transfer as a sell', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([row({ from: WALLET, to: OTHER, value: '5000000' })]))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements).toHaveLength(1)
    expect(result.movements[0].direction).toBe('sell')
    expect(result.movements[0].amount).toBe(5000000n)
  })

  it('drops self-transfers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([row({ from: WALLET, to: WALLET })]))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements).toEqual([])
  })

  it('compares addresses case-insensitively', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okResponse([row({ to: WALLET.toLowerCase(), from: OTHER.toUpperCase().replace('0X', '0x') })])
    )

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements).toHaveLength(1)
    expect(result.movements[0].direction).toBe('buy')
  })

  it('orders movements by block number then transaction index then API order', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okResponse([
        row({ blockNumber: '200', transactionIndex: '0', hash: '0x03', value: '3' }),
        row({ blockNumber: '100', transactionIndex: '5', hash: '0x01', value: '1' }),
        row({ blockNumber: '100', transactionIndex: '2', hash: '0x00', value: '0' }),
        row({ blockNumber: '100', transactionIndex: '2', hash: '0x02', value: '2' }),
      ])
    )

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements.map((m) => m.hash)).toEqual(['0x00', '0x02', '0x01', '0x03'])
  })

  it('paginates until a page comes back short', async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      row({ hash: `0xp1-${i}`, blockNumber: String(i + 1) })
    )
    const page2 = [row({ hash: '0xp2-0', blockNumber: '3' })]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(page1))
      .mockResolvedValueOnce(okResponse(page2))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock, pageSize: 2 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.movements).toHaveLength(3)
    expect(fetchMock.mock.calls[0][0]).toContain('page=1')
    expect(fetchMock.mock.calls[1][0]).toContain('page=2')
  })

  it('stops pagination on an empty page', async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      row({ hash: `0xp1-${i}`, blockNumber: String(i + 1) })
    )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(page1))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) })

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock, pageSize: 2 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.movements).toHaveLength(2)
  })

  it('returns an empty movements list for a wallet with no transfers, reading symbol/decimals on-chain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) })
    const readContract = vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'symbol') return Promise.resolve('USDC')
      if (functionName === 'decimals') return Promise.resolve(6)
      throw new Error(`unexpected call: ${functionName}`)
    })

    const result = await fetchTransfers(TOKEN, WALLET, {
      fetch: fetchMock,
      publicClient: { readContract } as never,
    })

    expect(result.movements).toEqual([])
    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })

  it('throws a clear error for an invalid wallet address', async () => {
    await expect(fetchTransfers(TOKEN, 'not-an-address')).rejects.toThrow(/invalid wallet/i)
  })

  it('throws a clear error for an invalid token address', async () => {
    await expect(fetchTransfers('not-an-address', WALLET)).rejects.toThrow(/invalid token/i)
  })

  it('throws on an HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })).rejects.toThrow(/500/)
  })

  it('throws on a Blockscout status "0" error that is not "no transactions found"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: '0', message: 'Error! Invalid address format', result: [] }) })

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })).rejects.toThrow(/invalid address format/i)
  })

  it('ignores a row where neither side is the wallet (defensive)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([row({ from: OTHER, to: THIRD })]))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements).toEqual([])
  })
})

describe('balanceOf', () => {
  it('reads the ERC-20 balance via the injected public client', async () => {
    const readContract = vi.fn().mockResolvedValue(123456789n)

    const balance = await balanceOf(TOKEN, WALLET, { publicClient: { readContract } as never })

    expect(balance).toBe(123456789n)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf', args: [WALLET] })
    )
  })

  it('throws a clear error for an invalid wallet address', async () => {
    await expect(balanceOf(TOKEN, 'nope', {})).rejects.toThrow(/invalid wallet/i)
  })

  it('throws a clear error for an invalid token address', async () => {
    await expect(balanceOf('nope', WALLET, {})).rejects.toThrow(/invalid token/i)
  })
})

describe.skipIf(!process.env.LIVE)('live Blockscout + RPC (opt-in, run with LIVE=1)', () => {
  it('fetches real transfers and balance for a known wallet/token pair', async () => {
    const liveToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
    const liveWallet = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // Binance 8

    const result = await fetchTransfers(liveToken, liveWallet)
    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
    expect(result.movements.length).toBeGreaterThan(0)

    const balance = await balanceOf(liveToken, liveWallet)
    expect(typeof balance).toBe('bigint')
  }, 30000)
})
