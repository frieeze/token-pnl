import { describe, expect, it } from 'vitest'
import { parseWallets } from './wallets'

const A = '0xF977814e90dA44bFA03b6295A0616a897441aceC'
const B = '0x2222222222222222222222222222222222222222'

describe('parseWallets', () => {
  it('reads addresses separated by newlines, spaces or commas, in the order given', () => {
    expect(parseWallets(` ${B}\n${A}, `)).toEqual({ wallets: [B, A] })
  })

  it('removes duplicates case-insensitively, keeping the first', () => {
    expect(parseWallets(`${A}\n${A.toLowerCase()}\n${B}`)).toEqual({ wallets: [A, B] })
  })

  it('names the first invalid address', () => {
    expect(parseWallets(`${A}\n0x123`)).toEqual({ error: expect.stringMatching(/Invalid wallet address: 0x123/) })
  })

  it('needs at least one address', () => {
    expect(parseWallets(' \n ')).toEqual({ error: expect.stringMatching(/at least one wallet/i) })
  })

  it('takes at most 5 addresses once duplicates are removed', () => {
    const six = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`)
    expect(parseWallets(six.join('\n'))).toEqual({ error: expect.stringMatching(/at most 5/i) })
    expect(parseWallets([...six.slice(0, 5), six[0]].join('\n'))).toHaveProperty('wallets')
  })
})
