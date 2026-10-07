# Hookline

**The intelligence layer for onchain hooks.**

Hookline is a multichain evidence and analytics desk for programmable-liquidity contracts. It gives researchers, builders, and agents a consistent way to inspect deployed hook code, decode permissions, preserve observations, compare contracts, monitor network health, and consume the same evidence through an API.

[Live desk](https://hookline.world) · [RPC documentation](https://hookline.world/rpc) · [X](https://x.com/_hookline)

## What works today

- Live contract inspection on Ethereum, Base, Arbitrum One, and Robinhood Chain
- Cross-chain hook board with 1,000+ active hook identities across 10+ chains
- Searchable community project directory with explicit source labels
- Aggregate indexed pool and swap counts with snapshot timestamps
- Shareable hook profile URLs, filtered JSON exports, and inline live inspection
- Deployed-bytecode size and SHA-256 runtime fingerprints
- Best-effort `owner()` probing with explicit probe status
- Canonical Uniswap v4 low-14-bit permission decoding
- Named local watchlists with bounded evidence history
- Same-chain contract and permission comparisons
- Live upstream health, block height, and latency telemetry
- Persistent Telegram alerts for new hook pools and 10% liquidity moves
- Free, allowlisted JSON-RPC access
- x402-protected capacity at 0.01 USDC per request on Base

The board's discovery and aggregate counts come from a timestamped v4.xyz community-indexer snapshot. Project descriptions are community-curated, project-submitted, or Hookline-researched and labeled in the interface. Direct live evidence still comes from Hookline's configured RPC endpoints. Telegram alerts monitor resolved markets on a bounded 10-minute schedule. First-party event indexing and long-range history remain roadmap work.

## Quick start

Requirements: Node.js 22 or newer.

```sh
npm ci
node scripts/build-hookline-worker.mjs
node scripts/test-hookline-worker.mjs
node node_modules/wrangler/bin/wrangler.js dev --config wrangler.jsonc
```

Open `http://127.0.0.1:8787`.

Inspect a Base contract through the public RPC:

```sh
curl https://hookline.world/rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "method":"hookline_getHook",
    "params":[8453,"0xb08211d57032dd10b1974d4b876851a7f7596888"],
    "id":1
  }'
```

## Repository map

```text
dist/                         browser application and generated Worker artifact
worker/index.js               maintainable Cloudflare Worker source
scripts/sync-hook-board.mjs   reproducible community-index snapshot sync
scripts/build-hookline-worker.mjs
scripts/test-hookline-worker.mjs
docs/                         product, API, whitepaper, roadmap, and FAQ
wrangler.jsonc                Cloudflare deployment configuration
```

The build script embeds `dist/index.html`, `dist/styles.css`, `dist/app.js`, and the generated `dist/hooks.json` snapshot into a single Cloudflare Worker artifact at `dist/server/index.js`.

## Data model

Contract identity is always:

```text
chain ID + normalized contract address
```

Every successful observation retains the chain, address, observed block, timestamp, runtime fingerprint, bytecode length, permission state, owner-probe result, and request latency. A failed refresh never overwrites the most recent successful evidence.

See [Product documentation](docs/PRODUCT.md), [API reference](docs/API.md), [Whitepaper](docs/WHITEPAPER.md), [Roadmap](docs/ROADMAP.md), and [FAQ](docs/FAQ.md).

## Public endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Service status |
| `GET /metrics` | Current chain health, height, and latency |
| `GET /data/hooks.json` | Timestamped cross-chain hook-board snapshot |
| `GET /rpc` | Machine-readable RPC reference |
| `POST /rpc` | Hookline methods |
| `POST /rpc/{chainId}` | Allowlisted Ethereum JSON-RPC proxy |
| `POST /rpc/paid` | x402-protected Hookline methods |

The public proxy does not submit transactions. It rejects write, account, administrative, debug, trace, and batch requests.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Security reports should follow [SECURITY.md](SECURITY.md) rather than being posted publicly.

Hookline is an independent project. It is not affiliated with or endorsed by Uniswap Labs, Robinhood, Flaunch, PayAI, or the upstream RPC providers.
