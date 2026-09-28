import { erc20Abi, erc20Abi_bytes32, toHex } from 'viem'
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

/**
 * A fake Blockscout `tokentx` over `history` (already in chain order): honours `startblock`,
 * `page` and `offset`, and errors past page x offset = 10,000 like the real one (checked
 * live 2026-09-27).
 */
function fakeBlockscout(history: ReturnType<typeof row>[]) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams
    const page = Number(q.get('page'))
    const offset = Number(q.get('offset'))
    if (page * offset > 10_000) {
      return {
        ok: true,
        json: async () => ({
          status: '0',
          message: 'Result window is too large, PageNo x Offset size must be less than or equal to 10000',
          result: null,
        }),
      }
    }
    const startblock = Number(q.get('startblock') ?? 0)
    const rows = history.filter((r) => Number(r.blockNumber) >= startblock).slice((page - 1) * offset, page * offset)
    if (rows.length === 0) {
      return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) }
    }
    return okResponse(rows)
  })
}

describe('fetchTransfers', () => {
  it('normalizes a single incoming transfer as in, from its sender', async () => {
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
        direction: 'in',
        counterparty: OTHER,
        amount: 1000000n,
      },
    ])
  })

  it('normalizes an outgoing transfer as out, to its recipient', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([row({ from: WALLET, to: OTHER, value: '5000000' })]))

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })

    expect(result.movements).toHaveLength(1)
    expect(result.movements[0].direction).toBe('out')
    expect(result.movements[0].counterparty).toBe(OTHER)
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
    expect(result.movements[0].direction).toBe('in')
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

  it('reads symbol/decimals independently: a bytes32 symbol (e.g. MKR) falls back and decodes, even when decimals fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) })
    const readContract = vi.fn().mockImplementation(({ abi, functionName }: { abi: unknown; functionName: string }) => {
      if (functionName === 'decimals') return Promise.reject(new Error('decimals() reverted'))
      if (functionName === 'symbol' && abi === erc20Abi) return Promise.reject(new Error('string decode failed'))
      if (functionName === 'symbol' && abi === erc20Abi_bytes32) return Promise.resolve(toHex('MKR', { size: 32 }))
      throw new Error(`unexpected call: ${functionName}`)
    })

    const result = await fetchTransfers(TOKEN, WALLET, {
      fetch: fetchMock,
      publicClient: { readContract } as never,
    })

    expect(result.symbol).toBe('MKR')
    expect(result.decimals).toBeNull()
  })

  it('reads symbol/decimals independently: decimals succeeds even when both symbol lookups fail', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) })
    const readContract = vi.fn().mockImplementation(({ abi, functionName }: { abi: unknown; functionName: string }) => {
      if (functionName === 'decimals') return Promise.resolve(18)
      if (functionName === 'symbol' && abi === erc20Abi) return Promise.reject(new Error('string decode failed'))
      if (functionName === 'symbol' && abi === erc20Abi_bytes32) return Promise.reject(new Error('bytes32 also failed'))
      throw new Error(`unexpected call: ${functionName}`)
    })

    const result = await fetchTransfers(TOKEN, WALLET, {
      fetch: fetchMock,
      publicClient: { readContract } as never,
    })

    expect(result.symbol).toBeNull()
    expect(result.decimals).toBe(18)
  })

  it('throws a clear error for an invalid wallet address', async () => {
    await expect(fetchTransfers(TOKEN, 'not-an-address')).rejects.toThrow(/invalid wallet/i)
  })

  it('throws a clear error for an invalid token address', async () => {
    await expect(fetchTransfers('not-an-address', WALLET)).rejects.toThrow(/invalid token/i)
  })

  it('throws on an HTTP error, falling back to statusText when the body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => {
        throw new SyntaxError('not json')
      },
    })

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })).rejects.toThrow(/500 Server Error/)
  })

  it('throws on an HTTP error, using the JSON body message when present (e.g. a 429)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({
        message: 'Too many requests. Increase limits now at https://dev.blockscout.com',
      }),
    })

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock })).rejects.toThrow(
      /429 Too many requests\. Increase limits now at/,
    )
  })

  it('continues past the 10,000-result cap by block range, with no duplicate or lost row at the boundaries', async () => {
    // 3 rows per block, so every window boundary splits a block: 25,500 rows over 8,500 blocks.
    const history = Array.from({ length: 25_500 }, (_, i) =>
      row({ hash: `0x${i}`, blockNumber: String(Math.floor(i / 3) + 1), transactionIndex: String(i % 3) }),
    )
    const fetchMock = fakeBlockscout(history)

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock as never, pageSize: 5000 })

    expect(result.movements.map((m) => m.hash)).toEqual(history.map((r) => r.hash))
  })

  it('handles a window that ends exactly on the cap: the next window only returns the boundary block', async () => {
    // 10,000 rows, the last two in the same block.
    const history = Array.from({ length: 10_000 }, (_, i) =>
      row({ hash: `0x${i}`, blockNumber: String(Math.min(i + 1, 9999)) }),
    )
    const fetchMock = fakeBlockscout(history)

    const result = await fetchTransfers(TOKEN, WALLET, { fetch: fetchMock as never, pageSize: 5000 })

    expect(result.movements.map((m) => m.hash)).toEqual(history.map((r) => r.hash))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][0]).toContain('startblock=9999')
  })

  it('throws instead of losing the boundary block when the next window comes back empty', async () => {
    const history = Array.from({ length: 10_000 }, (_, i) => row({ hash: `0x${i}`, blockNumber: String(i + 1) }))
    const real = fakeBlockscout(history)
    // An inconsistent indexer: nothing from the boundary block onwards.
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('startblock') === '0'
        ? real(url)
        : { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) },
    )

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock as never, pageSize: 5000 })).rejects.toThrow(
      /block 10000/,
    )
  })

  it('throws a clear error when one block has more transfers than a whole window', async () => {
    const history = Array.from({ length: 10_001 }, (_, i) => row({ hash: `0x${i}`, blockNumber: '42' }))
    const fetchMock = fakeBlockscout(history)

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock as never, pageSize: 5000 })).rejects.toThrow(
      /at least 10,000 transfers of this token in block 42/i,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws a clear error past the 200,000-transfer safety cap', async () => {
    // One row per block, generated on demand: far more history than the safety cap.
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams
      const first = Number(q.get('startblock') ?? 0) + (Number(q.get('page')) - 1) * Number(q.get('offset'))
      return okResponse(
        Array.from({ length: Number(q.get('offset')) }, (_, i) => row({ blockNumber: String(first + i) })),
      )
    })

    await expect(fetchTransfers(TOKEN, WALLET, { fetch: fetchMock as never, pageSize: 5000 })).rejects.toThrow(
      /more than 200,000 transfers/i,
    )
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
