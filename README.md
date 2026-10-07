# Hookline

**The intelligence layer for onchain hooks.**

Hookline is a multichain evidence and analytics desk for programmable-liquidity contracts. It gives researchers, builders, and agents a consistent way to inspect deployed hook code, decode permissions, preserve observations, compare contracts, monitor network health, and consume the same evidence through an API.

[Live desk](https://hookline.world) · [RPC documentation](https://hookline.world/rpc) · [HKLN on Base](https://basescan.org/token/0x11672C8cD5CB3F17364339244826B110Bac0AC91) · [X](https://x.com/_hookline)

## What works today

- Live contract inspection on Ethereum, Base, Arbitrum One, and Robinhood Chain
- Deployed-bytecode size and SHA-256 runtime fingerprints
- Best-effort `owner()` probing with explicit probe status
- Canonical Uniswap v4 low-14-bit permission decoding
- Named local watchlists with bounded evidence history
- Same-chain contract and permission comparisons
- Live upstream health, block height, and latency telemetry
- Free, allowlisted JSON-RPC access
- x402-protected capacity at 0.01 USDC per request on Base

Hookline currently provides point-in-time contract evidence. Event-indexed pool discovery, activity analytics, alerts, and long-range history are described in the roadmap and are not represented as shipped features.

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
scripts/build-hookline-worker.mjs
scripts/test-hookline-worker.mjs
docs/                         product, API, whitepaper, roadmap, and FAQ
token/                        public HKLN launch record
wrangler.jsonc                Cloudflare deployment configuration
```

The build script embeds `dist/index.html`, `dist/styles.css`, and `dist/app.js` into a single Cloudflare Worker artifact at `dist/server/index.js`.

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
| `GET /rpc` | Machine-readable RPC reference |
| `POST /rpc` | Hookline methods |
| `POST /rpc/{chainId}` | Allowlisted Ethereum JSON-RPC proxy |
| `POST /rpc/paid` | x402-protected Hookline methods |

The public proxy does not submit transactions. It rejects write, account, administrative, debug, trace, and batch requests.

## HKLN

HKLN is the service-alignment asset launched on Base.

```text
0x11672C8cD5CB3F17364339244826B110Bac0AC91
```

Current product access does not require holding HKLN. Paid RPC capacity settles in USDC through x402. Any future holder features must be shipped and documented before being treated as active utility.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Security reports should follow [SECURITY.md](SECURITY.md) rather than being posted publicly.

Hookline is an independent project. It is not affiliated with or endorsed by Uniswap Labs, Robinhood, Flaunch, PayAI, or the upstream RPC providers.
