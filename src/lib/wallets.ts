// Parses the wallets field of the form (D15): 1 to 5 addresses, duplicates removed.

import { getAddress, isAddress } from 'viem'

// Keeps the Blockscout and RPC calls within the free tiers (D15).
const MAX_WALLETS = 5

/** Addresses separated by whitespace or commas → checksummed, deduplicated, in the order given. */
export function parseWallets(text: string): { wallets: string[] } | { error: string } {
  const wallets: string[] = []
  for (const entry of text.split(/[\s,]+/).filter(Boolean)) {
    if (!isAddress(entry)) {
      return {
        error: `Invalid wallet address: ${entry}. Expected 0x followed by 40 hex characters (with a valid checksum if mixed-case).`,
      }
    }
    const wallet = getAddress(entry)
    if (!wallets.includes(wallet)) wallets.push(wallet)
  }
  if (wallets.length === 0) return { error: 'Enter at least one wallet address.' }
  if (wallets.length > MAX_WALLETS) return { error: `Enter at most ${MAX_WALLETS} wallet addresses.` }
  return { wallets }
}
