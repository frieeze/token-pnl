# Decisions

Format: each entry has a status (**Open** / **Decided**), the question, the options, and the outcome with its reason.

## D1. What counts as a "buy"? (Decided for v0, 2026-09-27)

Every token the wallet receives is a buy, whatever its source (swap, transfer, airdrop, bridge).
Reason: keeps v0 simple. Refine later (e.g. transfers between one's own wallets).

## D2. What counts as a "sell"? (Decided for v0, 2026-09-27)

Every token that leaves the wallet is a sell, whatever its destination.
Reason: keeps v0 simple and PnL always defined.

## D3. Cost basis method (Decided, 2026-09-27)

Weighted average cost. Total PnL (realized + unrealized) is the same as with FIFO;
only the split between realized and unrealized differs, and average cost is simpler.

## D4. Pricing strategy (Decided for v0, 2026-09-27)

Every movement is priced at the market price at its timestamp (DefiLlama historical price).
Reason: consistent with D1/D2 (every inflow is a buy, every outflow is a sell) and removes swap decoding from v0.
Later: price swaps from what was actually paid in the tx, with market price as fallback.

## D5. Gas fees (Decided for v0, 2026-09-27)

Ignored in v0.

## D6. Build vs buy (Decided: build, 2026-09-27)

Checked 2026-09-27. Moralis, Zerion and Mobula all have free tiers and a wallet-PnL endpoint, but:
- Moralis profitability covers only Ethereum, Polygon and Base, counts swaps only
  (conflicts with D1/D2), and the free plan is 40k compute units per month.
- Zerion caps its PnL endpoint at 25% of the plan quota, and it's a whole-wallet PnL.
- Mobula has a free key and wallet PnL; per-token accuracy and the method are not checked.
All three are hidden systems with their own buy/sell rules, which conflict with D1/D2.
Decision: build our own on free data; maybe use one of them later as a cross-check.

## D7. Form factor and stack (Decided, 2026-09-27)

Small web page, Svelte, viem for chain-related work.

## D8. Chains (Decided for v0, 2026-09-27)

Ethereum mainnet only. Transfers from Blockscout (`eth.blockscout.com`), prices from DefiLlama.

## D9. Budget (Decided, 2026-09-27)

Free tools first. If free tools prove too limited, the user can provide an Alchemy key and a DefiLlama key.
