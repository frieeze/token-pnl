# token-pnl

Compute the overall PnL of 1 to 5 wallets of the same user on one EVM token, as one portfolio.

**Input:** token address, chain, 1 to 5 wallet addresses
**Output:** total PnL (realized + unrealized) of those wallets on that token, in USD.

## Usage

Open the page, paste a token address and 1 to 5 wallet addresses, one per line (Ethereum only), and submit.
The inputs go in the URL (`?token=0x…&wallet=0x…&wallet=0x…`), so a result can be shared or reloaded.

Each movement's class can be changed to any class of the same direction with the dropdown in the
Class column; overridden rows are marked. Overrides are stored in the `overrides` URL param, so a
shared link reproduces the same result.

## Docs

- [docs/overview.md](docs/overview.md): problem, approach, data sources
- [docs/decisions.md](docs/decisions.md): decision log (open questions and settled choices)
- [docs/pnl-rules.md](docs/pnl-rules.md): how the PnL is computed (source of truth for tests)

## Development

A single static page: Svelte 5 + Vite + TypeScript, using `viem` for chain-related work. No SvelteKit.

Requires Node 22.12+ (developed on Node 24, see `.nvmrc`).

```sh
npm install    # install dependencies
npm run dev    # serve the app locally with hot reload
npm run build  # produce a production build in dist/
npm test       # run the unit tests (Vitest)
npm run check  # type-check the app (svelte-check)
```

Unit tests mock the network. Three opt-in live tests hit the real APIs and are skipped by default:
`src/lib/transfers.test.ts` (Blockscout and a public Ethereum RPC), `src/lib/prices.test.ts` (DefiLlama)
and `src/lib/classify.test.ts` (public Ethereum RPC only).
Run them with:

```sh
LIVE=1 npm test                              # all live tests
LIVE=1 npm test -- src/lib/prices.test.ts    # only one file
```
