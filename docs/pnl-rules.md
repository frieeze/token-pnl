# PnL rules (v0)

The source of truth for how the PnL is computed. Tickets and tests refer to this file.
Background for each rule is in [decisions.md](decisions.md).

## Movements

A **movement** is one ERC-20 `Transfer` of the token that touches the wallet.

- `to == wallet` → **buy** of `amount` (D1).
- `from == wallet` → **sell** of `amount` (D2).
- `from == to == wallet` (self-transfer) → ignored: it changes nothing.
- Movements are processed in chain order: block number, then transaction index, then the order the API returned them in
  (Blockscout gives no log index).

Amounts are kept as raw integers (`bigint`) and converted with the token's decimals only for display and price math.

## Prices

- Each movement is priced at the token's USD market price at the block timestamp (D4), from DefiLlama.
- A movement DefiLlama has no price for is **unpriced**.
- The **current price** is DefiLlama's current USD price. It can also be missing.

## Accounting: weighted average cost (D3)

State: `held` (token quantity), `cost` (USD cost basis of `held`), `realized` (USD).

- **Buy** of `q` at price `p`: `held += q`, `cost += q × p`.
- **Sell** of `q` at price `p`: `avg = cost / held`, `realized += q × (p − avg)`, `cost −= q × avg`, `held −= q`.
- **Unpriced** movement: quantity still moves as above, but it counts with price 0 for cost and proceeds.
  The result is flagged **incomplete** and says how many movements are unpriced.
- A sell larger than `held` (possible with rebasing or fee-on-transfer tokens) is clamped:
  the excess counts as a sell at average cost 0, and the result is flagged **incomplete**.

## Result

- `realized`: from the rules above.
- `unrealized = held × currentPrice − cost`. Missing if the current price is missing.
- `total = realized + unrealized`. Missing if `unrealized` is missing.
- Also shown: `held`, `cost`, average cost, total bought and sold (quantity and USD), and the
  per-movement table (date, tx hash, direction, amount, price, USD value).
- Gas is ignored (D5).

## Sanity check

The final `held` is compared with the on-chain `balanceOf(wallet)` at the latest block.
If they differ, the page shows a warning (likely a rebasing, reflection or fee-on-transfer token).
