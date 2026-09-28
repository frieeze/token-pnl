# Decisions

Format: each entry has a status (**Open** / **Decided**), the question, the options, and the outcome with its reason.

## D1. What counts as a "buy"? (Decided for v0, 2026-09-27; replaced by D10)

Every token the wallet receives is a buy, whatever its source (swap, transfer, airdrop, bridge).
Reason: keeps v0 simple. Refine later (e.g. transfers between one's own wallets).

## D2. What counts as a "sell"? (Decided for v0, 2026-09-27; replaced by D10)

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

## D10. Classify movements instead of "every inflow is a buy" (Decided, 2026-09-27)

v0 counted staking, locks, lending and vault deposits, and their withdrawals, as sells and buys, which made the PnL noisy.
Each movement now gets a class: buy, sell, deposit, withdraw, reward, transfer in, transfer out.
Signals: the other legs of the same transaction (read from the tx and its receipt on the RPC), round trips to the
same address, and whether the counterparty is a contract. Rules in [pnl-rules.md](pnl-rules.md#classification).
The user can override the class of any row; heuristics will never catch every bridge, vault or airdrop.
Reason: a real trade always has an opposite leg in the same tx; parking tokens in a protocol does not.

## D11. Transfers to and from other wallets (Decided, 2026-09-27)

A transfer out to another wallet (EOA) removes the tokens at their average cost: no realized PnL.
A transfer in from another wallet counts at market price as its cost basis (as a buy, but not counted in "bought").
Reason: sending tokens away is not selling them. Listing one's own wallets was considered and left out for now (since done in D15).

## D12. Rewards and airdrops (Decided, 2026-09-27)

Rewards, airdrops and the extra returned by a withdrawal come in with a cost of 0.
Reason: all their value shows up as profit, when sold or as unrealized PnL.

## D13. Receipt tokens (Decided, 2026-09-27)

stETH, aTokens, vault shares, LP tokens and the like are not valued. "Token out, receipt token minted in the same tx"
is a deposit, and "receipt token burned, token in" is a withdrawal. The tokens still count as held while deposited.
Reason: valuing each protocol's receipt token is a project of its own.

## D14. Price from the transaction (Open)

Price trades from what was actually paid in the tx (D4 "later"). The receipts fetched for D10 make this cheap.
To do after D10 ships.

## D15. Several wallets of the same user (Decided, 2026-09-28)

The user gives 1 to 5 wallet addresses and gets one PnL for all of them. Their movements are merged into one list,
and transfers between two of the wallets are ignored. Classification looks at the legs of all the wallets
(A pays, B receives is a buy), and the balance check sums the balance of each wallet.
No PnL per wallet: the table shows which wallet each movement belongs to.
Reason: tokens moved between one's own wallets are not bought or sold. Summing a PnL per wallet instead would lose
the gain between the sender's average cost and the market price at the time of the transfer (D11).
The cap of 5 keeps the Blockscout and RPC calls within the free tiers.
