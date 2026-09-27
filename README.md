# token-pnl

Compute the overall PnL of one wallet on one EVM token.

**Input:** token address, chain, wallet address
**Output:** total PnL (realized + unrealized) of that wallet on that token, in USD.

## Docs

- [docs/overview.md](docs/overview.md): problem, approach, data sources
- [docs/decisions.md](docs/decisions.md): decision log (open questions and settled choices)
- [docs/pnl-rules.md](docs/pnl-rules.md): how the PnL is computed (source of truth for tests)
