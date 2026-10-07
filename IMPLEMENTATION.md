# Hookline implementation

Hookline is the intelligence layer for onchain hooks. The current release is a live multichain desk for contract inspection, permission decoding, evidence history, network telemetry, watchlists, developer access, and a public Docs surface covering the product, data model, API, whitepaper, roadmap, and FAQ.

## Runtime

Cloudflare Worker source lives in `worker/index.js`. `scripts/build-hookline-worker.mjs` embeds the three browser assets from `dist/` into `dist/server/index.js`:

- `dist/index.html` contains the semantic application shell.
- `dist/styles.css` provides the responsive terminal-style interface.
- `dist/app.js` handles live inspections, watchlists, comparisons, telemetry, routing, local persistence, and WebMCP registration.

The Worker serves the app and these endpoints:

- `GET /health` for service status.
- `GET /metrics` for current upstream chain health, block height, and latency.
- `GET /rpc` for machine-readable RPC documentation.
- `POST /rpc` for Hookline JSON-RPC methods.
- `POST /rpc/{chainId}` for an allowlisted Ethereum JSON-RPC proxy.
- `POST /rpc/paid` for x402-protected capacity at 0.01 USDC per request on Base.

Production domains are `hookline.world`, `www.hookline.world`, and `hookline.ravenos.xyz`. The `www` hostname permanently redirects to the apex domain. Cloudflare configuration lives in `wrangler.jsonc` and uses the Free plan.

## Data provenance

Current evidence comes directly from configured public RPC upstreams:

- Ethereum: `https://eth.drpc.org`
- Base: `https://base-rpc.publicnode.com`
- Arbitrum One: `https://arb1.arbitrum.io/rpc`
- Robinhood Chain: `https://robinhood.drpc.org`

An inspection reads deployed runtime bytecode, probes `owner()` when supported, calculates a SHA-256 runtime fingerprint, decodes the low 14 hook-address permission bits, and records the latest block. The interface never manufactures a successful observation. Failed refreshes retain the last successful evidence and show the new error separately.

The current release provides point-in-time contract evidence. Pool discovery, swaps, liquidity changes, adoption metrics, and long-range history require the planned event indexer based on official PoolManager events.

## Browser storage

Named watchlists are stored in browser `localStorage` under `hookline:watchlists:v3`. Identity is always chain ID plus normalized contract address. The app migrates the previous v2 list when present.

Limits are 20 lists, 100 contracts per list, and 100 observations per contract. Refresh-all uses two concurrent workers. JSON import is capped at 1 MB, validates the v3 structure, deduplicates identities, and merges without deleting existing lists. Export produces a portable JSON file.

No automatic polling runs in the browser. Network probes occur only at page load or when a user explicitly inspects or refreshes data.

## RPC methods and safety

Hookline methods are:

- `hookline_chains`
- `hookline_decodePermissions`
- `hookline_chainStatus`
- `hookline_getHook`

The public proxy uses an explicit allowlist and rejects transaction submission, account access, administrative methods, debug methods, trace methods, batches, oversized bodies, and oversized upstream responses. Requests time out after eight seconds. Public POST routes use a best-effort per-isolate limit of 60 requests per IP per minute.

The paid route uses the official x402 Hono middleware, PayAI facilitator, `eip155:8453`, and Base USDC. Its settlement address is supplied at runtime through the encrypted `X402_PAY_TO` Worker secret and is not stored in source. Facilitator initialization is lazy because Cloudflare Workers do not permit network activity during module initialization.

## WebMCP

When `document.modelContext.registerTool` exists, the app registers:

- `inspect_hook` to fetch live evidence for a supported-chain contract.
- `decode_hook_address` to decode the canonical 14 permission bits.
- `list_hookline_watchlists` to return locally saved list names and identities.

Registration is feature-detected and non-fatal. The normal browser experience does not depend on WebMCP support.

## Build, test, and deploy

```sh
node --check dist/app.js
node --check worker/index.js
node scripts/build-hookline-worker.mjs
node scripts/test-hookline-worker.mjs
node node_modules/wrangler/bin/wrangler.js dev --config wrangler.jsonc
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.jsonc
```

The test suite checks static delivery, public claims, metrics behavior, x402 payment terms, malformed requests, permission decoding, contract inspection, method restrictions, size limits, rate limits, and the canonical-domain redirect.

## Next data layer

The next product step is a sourced event index that maps hooks to pools, chains, deployers, code versions, swaps, and liquidity events. Every derived metric should retain chain, contract, block range, timestamp, and source. Explorer labels, verified source metadata, token prices, and project-submitted profiles should remain visibly distinct from direct onchain observations.
