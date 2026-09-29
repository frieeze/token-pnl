import { describe, expect, it, vi } from 'vitest'
import { readCache, readTxCache, writeCache, writeTxCache, type CacheStorage, type CachedTx } from './cache'

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WALLET = '0xF977814e90dA44bFA03b6295A0616a897441aceC'
const HASH = '0xAB'.padEnd(66, '0')

function row(overrides: Partial<Record<string, string>> = {}) {
  return {
    hash: '0xaa',
    blockNumber: '100',
    transactionIndex: '1',
    timeStamp: '1700000000',
    from: '0x1111111111111111111111111111111111111111',
    to: WALLET,
    value: '1000000',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    ...overrides,
  }
}

/** In-memory fake of the `Storage` slice the cache uses. */
function fakeStorage(initial: Record<string, string> = {}): CacheStorage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value)
    },
    removeItem: (key) => {
      store.delete(key)
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

describe('readCache', () => {
  it('returns null when there is no cached entry', () => {
    const storage = fakeStorage()
    expect(readCache(storage, TOKEN, WALLET)).toBeNull()
  })

  it('returns the cached rows for a valid entry', () => {
    const rows = [row()]
    const storage = fakeStorage({
      [`token-pnl:transfers:${TOKEN.toLowerCase()}:${WALLET.toLowerCase()}`]: JSON.stringify({ v: 1, rows }),
    })

    expect(readCache(storage, TOKEN, WALLET)).toEqual(rows)
  })

  it('keys entries by lowercased token and wallet', () => {
    const rows = [row()]
    const storage = fakeStorage({
      [`token-pnl:transfers:${TOKEN.toLowerCase()}:${WALLET.toLowerCase()}`]: JSON.stringify({ v: 1, rows }),
    })

    expect(readCache(storage, TOKEN.toUpperCase().replace('0X', '0x'), WALLET)).toEqual(rows)
  })

  it('returns null and does not throw for corrupt JSON', () => {
    const storage = fakeStorage({
      [`token-pnl:transfers:${TOKEN.toLowerCase()}:${WALLET.toLowerCase()}`]: '{not json',
    })

    expect(readCache(storage, TOKEN, WALLET)).toBeNull()
  })

  it('returns null for an entry with the wrong schema version', () => {
    const storage = fakeStorage({
      [`token-pnl:transfers:${TOKEN.toLowerCase()}:${WALLET.toLowerCase()}`]: JSON.stringify({ v: 999, rows: [row()] }),
    })

    expect(readCache(storage, TOKEN, WALLET)).toBeNull()
  })

  it('returns null when storage is undefined', () => {
    expect(readCache(undefined, TOKEN, WALLET)).toBeNull()
  })

  it('returns null and does not throw if storage.getItem throws', () => {
    const storage: CacheStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }

    expect(readCache(storage, TOKEN, WALLET)).toBeNull()
  })
})

describe('writeCache', () => {
  it('stores the rows under the versioned entry', () => {
    const storage = fakeStorage()
    const rows = [row()]

    writeCache(storage, TOKEN, WALLET, rows)

    expect(readCache(storage, TOKEN, WALLET)).toEqual(rows)
  })

  it('keeps only the fields the app reads', () => {
    const storage = fakeStorage()
    const raw = { ...row(), input: '0x' + 'ab'.repeat(500), gasUsed: '21000', tokenName: 'USD Coin' }

    writeCache(storage, TOKEN, WALLET, [raw])

    expect(readCache(storage, TOKEN, WALLET)).toEqual([row()])
  })

  it('does nothing when storage is undefined', () => {
    expect(() => writeCache(undefined, TOKEN, WALLET, [row()])).not.toThrow()
  })

  it('evicts other token-pnl:transfers: entries and retries once on a quota error', () => {
    const storage = fakeStorage({
      'token-pnl:transfers:0xold:0xold': JSON.stringify({ v: 1, rows: [] }),
      'unrelated-key': 'keep me',
    })
    let attempts = 0
    const realSetItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      attempts++
      if (attempts === 1) throw new DOMException('quota exceeded', 'QuotaExceededError')
      realSetItem(key, value)
    }

    writeCache(storage, TOKEN, WALLET, [row()])

    expect(storage.getItem('token-pnl:transfers:0xold:0xold')).toBeNull()
    expect(storage.getItem('unrelated-key')).toBe('keep me')
    expect(readCache(storage, TOKEN, WALLET)).toEqual([row()])
  })

  it('skips caching silently if the write still fails after evicting', () => {
    const storage: CacheStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
      removeItem: vi.fn(),
      key: () => null,
      length: 0,
    }

    expect(() => writeCache(storage, TOKEN, WALLET, [row()])).not.toThrow()
  })
})

function txData(overrides: Partial<CachedTx> = {}): CachedTx {
  return {
    from: '0x1111111111111111111111111111111111111111',
    value: '1000000000000000000',
    logs: [{ address: TOKEN, topics: ['0xtransfer', '0xfrom', '0xto'], data: '0x01' }],
    ...overrides,
  }
}

describe('readTxCache', () => {
  it('returns null when there is no cached entry', () => {
    expect(readTxCache(fakeStorage(), HASH)).toBeNull()
  })

  it('returns the cached tx for a valid entry', () => {
    const tx = txData()
    const storage = fakeStorage({ [`token-pnl:tx:${HASH.toLowerCase()}`]: JSON.stringify({ v: 1, ...tx }) })

    expect(readTxCache(storage, HASH)).toEqual(tx)
  })

  it('keys entries by lowercased hash', () => {
    const tx = txData()
    const storage = fakeStorage({ [`token-pnl:tx:${HASH.toLowerCase()}`]: JSON.stringify({ v: 1, ...tx }) })

    expect(readTxCache(storage, HASH.toUpperCase().replace('0X', '0x'))).toEqual(tx)
  })

  it('returns null and does not throw for corrupt JSON', () => {
    const storage = fakeStorage({ [`token-pnl:tx:${HASH.toLowerCase()}`]: '{not json' })
    expect(readTxCache(storage, HASH)).toBeNull()
  })

  it('returns null for an entry with the wrong schema version', () => {
    const storage = fakeStorage({ [`token-pnl:tx:${HASH.toLowerCase()}`]: JSON.stringify({ v: 999, ...txData() }) })
    expect(readTxCache(storage, HASH)).toBeNull()
  })

  it('returns null when storage is undefined', () => {
    expect(readTxCache(undefined, HASH)).toBeNull()
  })
})

describe('writeTxCache', () => {
  it('stores the tx under the versioned entry', () => {
    const storage = fakeStorage()
    const tx = txData()

    writeTxCache(storage, HASH, tx)

    expect(readTxCache(storage, HASH)).toEqual(tx)
  })

  it('does nothing when storage is undefined', () => {
    expect(() => writeTxCache(undefined, HASH, txData())).not.toThrow()
  })

  it('evicts other token-pnl:tx: entries (not token-pnl:transfers: ones) and retries once on a quota error', () => {
    const storage = fakeStorage({
      'token-pnl:tx:0xold': JSON.stringify({ v: 1, ...txData() }),
      [`token-pnl:transfers:${TOKEN.toLowerCase()}:${WALLET.toLowerCase()}`]: JSON.stringify({ v: 1, rows: [row()] }),
    })
    let attempts = 0
    const realSetItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      attempts++
      if (attempts === 1) throw new DOMException('quota exceeded', 'QuotaExceededError')
      realSetItem(key, value)
    }

    writeTxCache(storage, HASH, txData())

    expect(storage.getItem('token-pnl:tx:0xold')).toBeNull()
    expect(readCache(storage, TOKEN, WALLET)).toEqual([row()])
    expect(readTxCache(storage, HASH)).toEqual(txData())
  })

  it('skips caching silently if the write still fails after evicting', () => {
    const storage: CacheStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
      removeItem: vi.fn(),
      key: () => null,
      length: 0,
    }

    expect(() => writeTxCache(storage, HASH, txData())).not.toThrow()
  })
})
