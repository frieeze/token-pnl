# Overview

## Problem

Given `(chain, token, wallets)` (1 to 5 wallets of the same user, D15), work out how much they made or lost on the token:
every time it acquired the token, at what price; every time it got rid of it, at what price;
and what the remaining balance is worth now.

## Pipeline (draft)

1. **Collect movements.** All ERC-20 `Transfer` events of `token` where one of the wallets is sender or receiver
   (transfers between two of the wallets are dropped),
   with block, timestamp and tx hash.
2. **Classify each movement.** Buy, sell, deposit, withdraw, reward, transfer in/out (D10).
   This decides how it affects cost basis.
3. **Price each movement** at its time (the hard part, see below).
4. **Run the accounting.** Cost basis method on the ordered list of movements, giving realized PnL
   on disposals.
5. **Mark to market.** Current balance × current price gives unrealized PnL.

## The hard part: historical prices (1-2 years back)

Two ways to price a buy:

- **A. Price from the transaction itself.** Look at what else moved in the same tx
  (e.g. wallet sent 0.5 ETH or 1,000 USDC and got N tokens). That is the price actually paid,
  slippage and all. Only the quote asset (ETH, USDC, WBTC…) then needs a historical USD price,
  and those are easy to get for any date.
- **B. Market price at the timestamp.** Ask a price API for the token's USD price at that time.
  Simple, but approximate, and coverage for small or dead tokens is patchy, especially long ago.

v0 uses **B only** (see D4). A is a later improvement.

## Data sources (checked 2026-09-27)

| Need | Source | Status |
|---|---|---|
| Transfer history | **Blockscout** Etherscan-compatible API (`module=account&action=tokentx`), one host per chain (`eth.blockscout.com`, `base.blockscout.com`, …) | Free, no key, CORS `*`: callable straight from the browser. Tested on Ethereum and Base |
| Transfer history (alt) | Etherscan V2 | Free tier no longer covers Base, Optimism or BNB Chain |
| Transfer history (alt) | Alchemy `alchemy_getAssetTransfers` | Free tier; user can provide a key |
| Transfer history (alt) | viem `getLogs` on a public RPC | Free, but block-range limits make 2 years of history slow |
| Historical USD price | **DefiLlama** `coins.llama.fi/prices/historical/{ts}/{chain}:{addr}` | Free, no key, CORS OK. Tested at 2 years back (PEPE, WETH). Several coins per call |
| Historical USD price (alt) | CoinGecko | Free "Demo" plan limited to the last 365 days: not enough |
| Current price | DefiLlama `prices/current` | Free |
| All-in-one PnL | Moralis / Zerion / Mobula | Not used, see D6 |

Open issue: Blockscout coverage per chain (especially BNB Chain) is not checked yet. Chains it lacks need another transfer source (Alchemy, or BSCTrace for BNB).
