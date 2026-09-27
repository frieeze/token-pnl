# PnL rules (v0)

The source of truth for how the PnL is computed. Tickets and tests refer to this file.
Background for each rule is in [decisions.md](decisions.md).

## Movements

A **movement** is one ERC-20 `Transfer` of the token that touches the wallet. It is **in** when `to == wallet` and
**out** when `from == wallet`. The other side is the **counterparty**.

- `from == to == wallet` (self-transfer) → ignored: it changes nothing.
- Movements are processed in chain order: block number, then transaction index, then the order the API returned them in
  (Blockscout gives no log index).

Amounts are kept as raw integers (`bigint`) and converted with the token's decimals only for display and price math.

## Classification

Each movement gets one class (D10). The **other legs** of its transaction are what the wallet sent or received
in that tx besides this token:

- another ERC-20 `Transfer` log to or from the wallet;
- ETH sent: the tx is from the wallet and its `value` > 0;
- ETH received: the tx is from the wallet and its logs hold a WETH `Withdrawal` (the router unwrapped WETH for it).

Rules, first match wins:

| # | Movement | Condition | Class |
|---|---|---|---|
| 1 | out | another token in, **minted** to the wallet (`from == 0x0`) | deposit (D13) |
| 2 | in | another token out, **burned** by the wallet (`to == 0x0`) | withdraw (D13) |
| 3 | in | ETH or another token out | buy |
| 4 | out | ETH or another token in | sell |
| 5 | in | from `0x0` (mint), no other leg | reward |
| 6 | out | to a contract, no other leg | deposit |
| 7 | in | from a contract with deposits still out (by the classifier's own count for that contract), no other leg | withdraw |
| 8 | in | from a contract, no other leg | reward |
| 9 | out | to a wallet (EOA) | transfer out |
| 10 | in | from a wallet (EOA) | transfer in |

A contract is an address with code (`eth_getCode`) at the latest block.
The user can override the class of any row with any class of the same direction (in: buy, withdraw, reward,
transfer in; out: sell, deposit, transfer out).

Known gap: a sell paid in native ETH with no WETH involved (e.g. Uniswap v4 native pools) has no visible ETH leg
and falls to deposit. The override fixes it.

## Prices

- Each movement is priced at the token's USD market price at the block timestamp (D4), from DefiLlama.
- A movement DefiLlama has no price for is **unpriced**. So is one whose price is not a finite number ≥ 0
  (bad data from the API is treated as no data).
- The **current price** is DefiLlama's current USD price. It can also be missing (same rule for bad values).
  A current price of exactly 0 is a real price.

## Accounting: weighted average cost (D3)

State: `held` (token quantity, **including** tokens deposited in protocols), `cost` (USD cost basis of `held`),
`realized` (USD), `deposited` (token quantity currently out in protocols).

- **Buy** of `q` at price `p`: `held += q`, `cost += q × p`.
- **Sell** of `q` at price `p`: `avg = cost / held`, `realized += q × (p − avg)`, `cost −= q × avg`, `held −= q`.
- **Transfer in** (D11): as a buy, but not counted in total bought.
- **Transfer out** (D11): `avg = cost / held`, `cost −= q × avg`, `held −= q`. No realized PnL, not counted in total sold.
- **Reward** (D12): `held += q`, cost unchanged (cost 0).
- **Deposit**: `deposited += q`. `held` and `cost` unchanged.
- **Withdraw**: `w = min(q, deposited)`, `deposited −= w`. The excess `q − w` counts as a reward.
- **Unpriced** movement: only buys, sells and transfers in need a price. For those, the quantity still moves as above,
  but it counts with price 0 for cost and proceeds. The result is flagged **incomplete** and says how many are unpriced.
- A sell or transfer out larger than `held − deposited` (possible with rebasing or fee-on-transfer tokens) is clamped:
  the excess counts at average cost 0, and the result is flagged **incomplete**.

## Result

- `realized`: from the rules above.
- `unrealized = held × currentPrice − cost`. Missing if the current price is missing.
- `total = realized + unrealized`. Missing if `unrealized` is missing.
  A missing current price is not an **incomplete** reason (the missing totals already say it);
  the page shows an explicit "no current price" message instead.
- Also shown: `held`, `deposited`, `cost`, average cost, total bought and sold (buys and sells only, quantity and USD),
  and the per-movement table (date, tx hash, class, amount, price, USD value).
- Average cost is missing when nothing is held.
- Total sold counts every sell, including the excess of an oversell.
- In the per-movement table an unpriced movement shows no price and no USD value (not $0),
  even though the totals count it at price 0.
- Gas is ignored (D5).

## Sanity check

The final `held − deposited` is compared with the on-chain `balanceOf(wallet)` at the latest block.
If they differ, the page shows a warning (likely a rebasing, reflection or fee-on-transfer token).
