# token-pnl

Compute the overall PnL of one wallet on one EVM token.

**Input:** token address, chain, wallet address
**Output:** total PnL (realized + unrealized) of that wallet on that token, in USD.

## Usage

Open the page, paste a token address and a wallet address (Ethereum only), and submit.
The inputs go in the URL (`?token=0x…&wallet=0x…`), so a result can be shared or reloaded.

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
