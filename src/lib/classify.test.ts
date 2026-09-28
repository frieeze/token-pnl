import { encodeEventTopics, erc20Abi, erc721Abi, numberToHex, parseAbi, zeroAddress, type Address, type Hash } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { applyRules, classifyMovements, type TxData } from './classify'
import type { Movement } from './transfers'

// Not ambiently declared under tsconfig.app.json (see transfers.test.ts).
declare const process: { env: Record<string, string | undefined> }

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const WALLET = '0xF977814e90dA44bFA03b6295A0616a897441aceC'
const OTHER_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const POOL = '0x1111111111111111111111111111111111111111'
const PEER = '0x2222222222222222222222222222222222222222'
const HASH: Hash = `0x${'ab'.repeat(32)}`

const transfer = (token: Address, from: Address, to: Address, value = 1n) => ({
  address: token.toLowerCase() as Address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as Hash[],
  data: numberToHex(value, { size: 32 }),
})
const wethWithdrawal = {
  address: WETH.toLowerCase() as Address,
  topics: encodeEventTopics({ abi: parseAbi(['event Withdrawal(address indexed src, uint wad)']), eventName: 'Withdrawal', args: { src: POOL } }) as Hash[],
  data: numberToHex(1n, { size: 32 }),
}

const nftTransfer = {
  address: OTHER_TOKEN.toLowerCase() as Address,
  topics: encodeEventTopics({ abi: erc721Abi, eventName: 'Transfer', args: { from: WALLET, to: POOL, tokenId: 1n } }) as Hash[],
  // Non-zero data, so only the topic count can exclude it (real ERC-721 logs have empty data).
  data: numberToHex(1n, { size: 32 }),
}

type Mv = Pick<Movement, 'hash' | 'direction' | 'counterparty' | 'amount'>
const mv = (direction: Movement['direction'], counterparty: Address = POOL, hash: Hash = HASH, amount = 1n): Mv => ({ hash, direction, counterparty, amount })
const tx = (overrides: Partial<TxData> = {}): TxData => ({ from: PEER, value: 0n, logs: [], ...overrides })

function classifyOne(m: Mv, t: TxData, contracts: Address[] = [POOL]) {
  return applyRules({ token: TOKEN, wallets: [WALLET], movements: [m], txs: new Map([[m.hash, t]]), contracts: new Set(contracts) })[0]
}

describe('applyRules', () => {
  it.each([
    ['1: out, another token minted in → deposit', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, POOL), transfer(OTHER_TOKEN, zeroAddress, WALLET)] }), 'deposit'],
    ['2: in, another token burned → withdraw', mv('in'), tx({ from: WALLET, logs: [transfer(OTHER_TOKEN, WALLET, zeroAddress), transfer(TOKEN, POOL, WALLET)] }), 'withdraw'],
    ['3: in, ETH out → buy', mv('in'), tx({ from: WALLET, value: 1n, logs: [transfer(TOKEN, POOL, WALLET)] }), 'buy'],
    ['3: in, another token out → buy', mv('in'), tx({ logs: [transfer(OTHER_TOKEN, WALLET, POOL), transfer(TOKEN, POOL, WALLET)] }), 'buy'],
    ['4: out, ETH in (WETH unwrapped) → sell', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, POOL), wethWithdrawal] }), 'sell'],
    ['4: out, another token in → sell', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, POOL), transfer(OTHER_TOKEN, POOL, WALLET)] }), 'sell'],
    ['3 before 5: in, minted while ETH goes out (paid mint) → buy', mv('in', zeroAddress), tx({ from: WALLET, value: 1n, logs: [transfer(TOKEN, zeroAddress, WALLET)] }), 'buy'],
    ['5: in, minted, no other leg → reward', mv('in', zeroAddress), tx({ logs: [transfer(TOKEN, zeroAddress, WALLET)] }), 'reward'],
    ['6: out to a contract, no other leg → deposit', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, POOL)] }), 'deposit'],
    ['8: in from a contract, no deposit out → reward', mv('in'), tx({ from: WALLET, logs: [transfer(TOKEN, POOL, WALLET)] }), 'reward'],
    ['9: out to a wallet (EOA) → transfer out', mv('out', PEER), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, PEER)] }), 'transferOut'],
    ['10: in from a wallet (EOA) → transfer in', mv('in', PEER), tx({ logs: [transfer(TOKEN, PEER, WALLET)] }), 'transferIn'],
    // Known gap: a sell paid in native ETH without WETH looks exactly like rule 6 (deposit).
  ] as const)('rule %s', (_name, m, t, expected) => {
    expect(classifyOne(m, t)).toBe(expected)
  })

  it.each([
    ['another transfer of this token', mv('in'), tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, PEER), transfer(TOKEN, POOL, WALLET)] }), 'reward'],
    ['ETH sent by someone else', mv('in', PEER), tx({ value: 1n, logs: [transfer(TOKEN, PEER, WALLET)] }), 'transferIn'],
    ['WETH unwrapped in a tx the wallet did not send', mv('out'), tx({ logs: [transfer(TOKEN, WALLET, POOL), wethWithdrawal] }), 'deposit'],
    ['a zero-value transfer of another token', mv('in', PEER), tx({ from: WALLET, logs: [transfer(OTHER_TOKEN, WALLET, PEER, 0n), transfer(TOKEN, PEER, WALLET)] }), 'transferIn'],
    ['an NFT transfer', mv('in'), tx({ from: WALLET, logs: [nftTransfer, transfer(TOKEN, POOL, WALLET)] }), 'reward'],
  ] as const)('does not count %s as a leg', (_name, m, t, expected) => {
    expect(classifyOne(m, t)).toBe(expected)
  })

  it('lets a leg in the same direction fall through to the counterparty rules (e.g. claiming two reward tokens)', () => {
    const t = tx({ from: WALLET, logs: [transfer(OTHER_TOKEN, POOL, WALLET), transfer(TOKEN, POOL, WALLET)] })
    expect(classifyOne(mv('in'), t)).toBe('reward')
  })

  it('rule 7: in from a contract with an amount still deposited → withdraw, tracked per contract in chain order', () => {
    const VAULT = '0x3333333333333333333333333333333333333333'
    const h = (n: number): Hash => `0x${String(n).padStart(64, '0')}`
    const movements = [
      mv('in', POOL, h(1), 10n), // nothing deposited yet: reward
      mv('out', POOL, h(2), 100n), // deposit: 100 out
      mv('in', VAULT, h(3), 10n), // other contract, nothing out there: reward
      mv('in', POOL, h(4), 50n), // withdraw: 50 left
      mv('in', POOL, h(5), 50n), // withdraw: 0 left
      mv('in', POOL, h(6), 10n), // reward
    ]
    const txs = new Map(movements.map((m) => [m.hash, tx()]))
    const classes = applyRules({ token: TOKEN, wallets: [WALLET], movements, txs, contracts: new Set([POOL, VAULT]) })
    expect(classes).toEqual(['reward', 'deposit', 'reward', 'withdraw', 'withdraw', 'reward'])
  })

  it('rule 7: a withdrawal above the amount out empties it, so the next in is a reward', () => {
    const h = (n: number): Hash => `0x${String(n).padStart(64, '0')}`
    const movements = [mv('out', POOL, h(1), 100n), mv('in', POOL, h(2), 120n), mv('in', POOL, h(3), 10n)]
    const txs = new Map(movements.map((m) => [m.hash, tx()]))
    const classes = applyRules({ token: TOKEN, wallets: [WALLET], movements, txs, contracts: new Set([POOL]) })
    expect(classes).toEqual(['deposit', 'withdraw', 'reward'])
  })
})

describe('applyRules with several wallets', () => {
  const B = '0x4444444444444444444444444444444444444444'
  const classifyOf = (m: Mv, t: TxData, contracts: Address[] = [POOL]) =>
    applyRules({ token: TOKEN, wallets: [WALLET, B], movements: [m], txs: new Map([[m.hash, t]]), contracts: new Set(contracts) })[0]

  it.each([
    ['in to B, ETH sent by A → buy', mv('in'), tx({ from: WALLET, value: 1n, logs: [transfer(TOKEN, POOL, B)] }), 'buy'],
    ['in to B, another token out of A → buy', mv('in'), tx({ logs: [transfer(OTHER_TOKEN, WALLET, POOL), transfer(TOKEN, POOL, B)] }), 'buy'],
    ['out of B, WETH unwrapped in a tx sent by A → sell', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, B, POOL), wethWithdrawal] }), 'sell'],
    ['out of B, another token minted to A → deposit', mv('out'), tx({ from: WALLET, logs: [transfer(TOKEN, B, POOL), transfer(OTHER_TOKEN, zeroAddress, WALLET)] }), 'deposit'],
    ['in to B, another token burned by A → withdraw', mv('in'), tx({ logs: [transfer(OTHER_TOKEN, WALLET, zeroAddress), transfer(TOKEN, POOL, B)] }), 'withdraw'],
  ] as const)('counts the legs of all the wallets: %s', (_name, m, t, expected) => {
    expect(classifyOf(m, t)).toBe(expected)
  })

  it('does not count a transfer of another token between two of the wallets as a leg', () => {
    const t = tx({ logs: [transfer(OTHER_TOKEN, WALLET, B), transfer(TOKEN, PEER, B)] })
    expect(classifyOf(mv('in', PEER), t)).toBe('transferIn')
  })

  it('does not count a transfer of another token from a wallet to itself as a leg (one wallet)', () => {
    const t = tx({ logs: [transfer(OTHER_TOKEN, WALLET, WALLET), transfer(TOKEN, PEER, WALLET)] })
    expect(classifyOne(mv('in', PEER), t)).toBe('transferIn')
  })

  it('rule 7: counts deposits per contract across all the wallets', () => {
    const h = (n: number): Hash => `0x${String(n).padStart(64, '0')}`
    const movements = [mv('out', POOL, h(1), 100n), mv('in', POOL, h(2), 100n)] // A deposits, B withdraws
    const txs = new Map([[h(1), tx({ logs: [transfer(TOKEN, WALLET, POOL)] })], [h(2), tx({ logs: [transfer(TOKEN, POOL, B)] })]])
    expect(applyRules({ token: TOKEN, wallets: [WALLET, B], movements, txs, contracts: new Set([POOL]) })).toEqual(['deposit', 'withdraw'])
  })
})

describe('classifyMovements', () => {
  const h = (n: number): Hash => `0x${String(n).padStart(64, '0')}`
  const movement = (n: number, direction: Movement['direction'], counterparty: Address): Movement => ({
    hash: h(n), blockNumber: BigInt(n), transactionIndex: 0, timestamp: n, direction, wallet: WALLET, counterparty, amount: 1n,
  })

  /** A stub viem client over fixed txs and code, recording what was asked. */
  function stubClient(txs: Record<Hash, TxData>, contracts: Address[]) {
    return {
      getTransaction: vi.fn(async ({ hash }: { hash: Hash }) => ({ from: txs[hash]!.from, value: txs[hash]!.value })),
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({ logs: txs[hash]!.logs })),
      getCode: vi.fn(async ({ address }: { address: Address }) => (contracts.includes(address) ? ('0x6080' as Hash) : undefined)),
    }
  }

  it('classifies from the RPC, reading code only for counterparties the legs leave undecided', async () => {
    const movements = [
      movement(1, 'in', POOL), // bought with ETH: no code needed
      movement(2, 'in', zeroAddress), // mint: no code needed
      movement(3, 'out', POOL), // no leg: POOL is a contract → deposit
      movement(4, 'in', PEER), // no leg: PEER is an EOA → transfer in
      movement(5, 'in', POOL), // no leg: from POOL with a deposit out → withdraw
    ]
    const client = stubClient(
      {
        [h(1)]: tx({ from: WALLET, value: 1n, logs: [transfer(TOKEN, POOL, WALLET)] }),
        [h(2)]: tx({ logs: [transfer(TOKEN, zeroAddress, WALLET)] }),
        [h(3)]: tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, POOL)] }),
        [h(4)]: tx({ logs: [transfer(TOKEN, PEER, WALLET)] }),
        [h(5)]: tx({ from: WALLET, logs: [transfer(TOKEN, POOL, WALLET)] }),
      },
      [POOL],
    )

    const classes = await classifyMovements(TOKEN, [WALLET], movements, { publicClient: client })

    expect(classes).toEqual(['buy', 'reward', 'deposit', 'transferIn', 'withdraw'])
    expect(client.getCode.mock.calls.map(([a]) => a.address).sort()).toEqual([POOL, PEER])
  })

  it('treats an EOA with an EIP-7702 delegation as a wallet', async () => {
    const client = stubClient({ [h(1)]: tx({ from: WALLET, logs: [transfer(TOKEN, WALLET, PEER)] }) }, [])
    client.getCode.mockResolvedValue(`0xef0100${POOL.slice(2).toLowerCase()}`)
    expect(await classifyMovements(TOKEN, [WALLET], [movement(1, 'out', PEER)], { publicClient: client })).toEqual(['transferOut'])
  })

  it('fetches transactions 50 at a time (one JSON-RPC batch per chunk)', async () => {
    const t = tx({ logs: [transfer(TOKEN, PEER, WALLET)] })
    const movements = Array.from({ length: 51 }, (_, i) => movement(i + 1, 'in', PEER))
    const client = stubClient(Object.fromEntries(movements.map((m) => [m.hash, t])), [])
    const onProgress = vi.fn()
    await classifyMovements(TOKEN, [WALLET], movements, { publicClient: client, onProgress })
    expect(onProgress.mock.calls).toEqual([[0, 51], [50, 51], [51, 51]])
  })

  it('fails with a clear message when an RPC call fails', async () => {
    const client = stubClient({ [h(1)]: tx() }, [])
    client.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error('long details'), { shortMessage: 'HTTP request failed.' }))
    await expect(
      classifyMovements(TOKEN, [WALLET], [movement(1, 'in', PEER)], { publicClient: client }),
    ).rejects.toThrow('RPC request failed while classifying movements: HTTP request failed.')
  })

  it('reports progress over the distinct transactions', async () => {
    const t = tx({ logs: [transfer(TOKEN, PEER, WALLET)] })
    const client = stubClient({ [h(1)]: t, [h(2)]: t }, [])
    const onProgress = vi.fn()
    const movements = [movement(1, 'in', PEER), movement(1, 'in', PEER), movement(2, 'in', PEER)]
    await classifyMovements(TOKEN, [WALLET], movements, { publicClient: client, onProgress })
    expect(onProgress.mock.calls).toEqual([[0, 2], [2, 2]])
    expect(client.getTransaction).toHaveBeenCalledTimes(2)
  })
})

// Real mainnet txs found 2026-09-28 by scanning recent PEPE and aEthUSDC Transfer logs over the RPC.
//   LIVE=1 npm test -- src/lib/classify.test.ts
describe.skipIf(!process.env.LIVE)('classifyMovements (live RPC, opt-in, run with LIVE=1)', () => {
  const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  it.each([
    ['buy with ETH', PEPE, '0xfA5b5c569A418933B08A016CA17b2d403d997E51', '0x0419c86a4abffb54d8bffc62e5f756976c7cbf2cf88eac456cbb17439eb7d618', 'in', '0xb300000b72DEAEb607a12d5f54773D1C19c7028d', 'buy'],
    ['sell for WETH unwrapped', PEPE, '0x673f1ab0d9e7cea0E7e5d50C9B0DBF597b0cb312', '0xf341889bf6b301c940d2f10b4f09802f7d77903db00c3bb67b26dd61c2147c7e', 'out', '0x11950d141EcB863F01007AdD7D1A342041227b58', 'sell'],
    ['transfer out to an EOA', PEPE, '0x2745d07dD4B9B1085ca5E9B0fB6E402fE20105dB', '0x1799a91b4a3149f80ba42b9fe69df2cd83736ccae1d79388abb4070bfd03e12b', 'out', '0x93228d328c9c74c2BFE9f97638bbb5ef322f2Bd5', 'transferOut'],
    ['Aave deposit (aToken minted)', USDC, '0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E', '0x97e8a0732252f9bfcc765d68986a7316a81ca892b9c39354844563ebbb4f7247', 'out', '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', 'deposit'],
  ] as const)('%s', async (_name, token, wallet, hash, direction, counterparty, expected) => {
    const m: Movement = { hash, blockNumber: 0n, transactionIndex: 0, timestamp: 0, direction, wallet, counterparty, amount: 1n }
    expect(await classifyMovements(token, [wallet], [m])).toEqual([expected])
  }, 30000)
})
