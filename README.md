# Hookline

**The intelligence layer for onchain hooks.**

Hookline is a multichain evidence and analytics desk for programmable-liquidity contracts. It gives researchers, builders, and agents a consistent way to inspect deployed hook code, decode permissions, preserve observations, compare contracts, monitor network health, and consume the same evidence through an API.

[Live desk](https://hookline.world) · [Projects](https://hookline.world/#/projects) · [Hook Tape](https://hookline.world/#/tape) · [Activity](https://hookline.world/#/activity) · [Documentation](https://hookline.world/#/docs) · [X](https://x.com/_hookline)

## What works today

- Live contract inspection on Ethereum, BNB Chain, Base, Arbitrum One, and Robinhood Chain
- Cross-chain hook board with 1,000+ active hook identities across 10+ chains
- Broad Projects board with source-linked deployments, coverage labels, shared observations, and selected mechanism events
- Base Hook Tape built from finalized PoolManager `Initialize` and `Swap` logs, with exact hook, pool, signed pool deltas, reported swap fee, block, and transaction evidence
- Bounded successful-receipt enrichment retaining relevant ERC-20 transfers that touch the hook or a pool currency, explicitly separate from fee attribution
- Bounded successful-transaction trace selection for direct hook callbacks, decoded swap-return deltas, explicit LP-fee overrides, hook-linked native value, and provider-reported hook call-frame gas
- Explicit block-window swap activity summaries, active-hook rankings, and sourced Telegram alerts for PoolManager fee moves of 10 basis points or more
- Private API submissions, suggestions, DNS domain claims, and metadata-only profile updates
- Aggregate indexed pool and swap counts with snapshot timestamps
- Shareable hook profile URLs, filtered JSON exports, and inline live inspection
- Deployed-bytecode size and SHA-256 runtime fingerprints
- Static runtime-family clustering across every live-inspection chain
- Best-effort `owner()` probing with explicit probe status
- Canonical Uniswap v4 low-14-bit permission decoding
- Named local watchlists with bounded evidence history
- Optional gas-free wallet sign-in for explicit private list/settings save and load across devices
- Lazy-loaded Privy login, explicit embedded-wallet creation, secure export, and external-wallet selection
- Private one-use Telegram linking without trading authority or silent settings merges
- CLAUS allocation/accrual/event separation, with exact same-receipt burn transfer confirmation where supported
- Doppler Airlock launch, migration, module-state, and fee-collection records on Base and Robinhood Chain
- Angstrom ControllerV1 pool configuration, authority, and node-set records on Ethereum
- Same-chain contract and permission comparisons
- Live upstream health, block height, and latency telemetry
- Persistent Telegram alerts for runtime changes, new finalized Base PoolManager relationships, material PoolManager fee moves, new community-indexed relationships, and 10% liquidity moves across an unchanged, fully measured indexed pool set
- Saved website slippage and buy/sell presets, with exact balance-percentage sizing
- Non-custodial reviewed EVM execution on supported markets with browser-wallet signing
- 1% gross execution fee, 0.3% instant cashback, and 0.7% effective fee bound into the route
- Independently reconciled execution receipts stored without keys, signatures, or signed transactions
- Free, allowlisted JSON-RPC access
- x402-protected capacity at 0.01 USDC per request on Base

The board's discovery and aggregate counts come from a timestamped v4.xyz community-indexer snapshot. The Base Tape is separate first-party evidence read from the official PoolManager contract: finalized initialization coverage stays current while a bounded cursor fills history, and a finalized live swap cursor retains rows for already-resolved hooked pools. Swap rows report signed pool deltas and the fee emitted by PoolManager. Successful receipt enrichment retains only normalized ERC-20 transfers that touch the saved hook or a pool currency, with transaction gas clearly labeled as transaction-level. A bounded trace pass then prioritizes receipt-backed transactions with hook-linked transfers and retains direct hook call frames, callback selectors and returns, relevant native value, and call-frame gas. A transfer or call frame is not automatically a hook fee or proof of its economic purpose. The selected traces contain successful transactions only and do not measure refusal rate. Block-window summaries aggregate only retained swap evidence and disclose whether the requested window is complete. Fee-change alerts compare the same resolved pool across complete finalized reads; they do not call the PoolManager fee a hook fee. Project descriptions are community-curated, team-authored, agent-reviewed, or Hookline-researched and labeled in the interface. Projects has its own broad registry, source-linked deployments, block-pinned observations, selected mechanism event readers, shared activity, and Telegram follows. Generalized fee attribution, rejected-attempt indexing, and lifetime payout reconciliation remain roadmap work. A confirmed individual burn transfer is not a lifetime total or investment outcome.

The October 7 Projects release starts with 39 records, including tokenized projects, launch infrastructure, liquidity mechanisms, and developer tooling. Ten projects have explicitly selected monitoring targets. A listed project is not automatically a monitored or verified deployment. [Release notes and current boundaries](docs/RELEASE_2026-10-07.md) distinguish what is measured from what remains planned.

Project suggestions, domain claims, and corrections are free through the API, website, or Telegram. No email or HKLN holding is required. Domain verification permits descriptive metadata updates only. [Contribution API](docs/PROJECT_CONTRIBUTIONS.md) and [project architecture](docs/PROJECTS_ARCHITECTURE.md) describe the private receipts, automated DNS checks, and authenticated review-agent workflow.

## Quick start

Requirements: Node.js 22 or newer.

```sh
npm ci
npm ci --prefix wallet-client
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
wallet-client/                isolated, pinned browser-only Privy/React package
scripts/sync-hook-board.mjs   reproducible community-index snapshot sync
scripts/build-hookline-worker.mjs
scripts/test-hookline-worker.mjs
docs/                         product, API, whitepaper, roadmap, and FAQ
wrangler.jsonc                Cloudflare deployment configuration
```

The build script embeds `dist/index.html`, `dist/styles.css`, `dist/app.js`, and the generated `dist/hooks.json` snapshot into a single Cloudflare Worker artifact at `dist/server/index.js`.

It also builds the isolated wallet client into `dist/privy-wallet.js`. The SDK loads only when someone opens Wallets; the evidence desk has no login dependency. Hookline's public Privy app ID is client configuration, not a secret. Google, email, and external wallets are enabled. Telegram and Apple login are intentionally disabled; the Telegram bot, alerts, and private identity links remain available separately. The live login picker reflects the dashboard's enabled methods, not a hard-coded promise. No paid plan, gas sponsorship, server signer, or session key is enabled by this build. Embedded EOA creation is not smart-account deployment.

## Data model

Contract identity is always:

```text
chain ID + normalized contract address
```

Every successful observation retains the chain, address, observed block, timestamp, runtime fingerprint, bytecode length, permission state, owner-probe result, and request latency. A failed refresh never overwrites the most recent successful evidence.

`npm run sync:runtimes` refreshes the deployed-bytecode family snapshot. The generated file is shipped with the site, so family browsing does not add per-page RPC or Cloudflare storage cost.

See [Product documentation](docs/PRODUCT.md), [API reference](docs/API.md), [Whitepaper](docs/WHITEPAPER.md), [Roadmap](docs/ROADMAP.md), and [FAQ](docs/FAQ.md).

## Public endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Service status |
| `GET /metrics` | Current chain health, height, and latency |
| `GET /data/hooks.json` | Timestamped cross-chain hook-board snapshot |
| `GET /api/projects` | Project registry, sources, and actual observed coverage |
| `GET /api/projects/{id}` | Deployment state, selected event history, and scan progress |
| `GET /api/project-activity` | Shared project change feed with project, signal, and history filters |
| `GET /api/project-comparison?ids={ids}` | Two to four projects using a common evidence schema |
| `GET /api/tape/status` | Base PoolManager index coverage, cursors, and saved evidence counts |
| `GET /api/tape/pools` | Finalized Base pool initialization evidence, optionally filtered by hook |
| `GET /api/tape/swaps` | Finalized Base swap evidence for already-resolved hooked pools |
| `GET /api/tape/activity` | Explicit block-window swap activity and PoolManager fee summaries |
| `POST /api/project-submissions` | Private suggestions, listings, corrections, and domain claims |
| `GET /api/execution/status` | Current reviewed-execution capability by chain |
| `POST /api/execution/quote` | Short-lived, wallet-bound route and opaque intent |
| `POST /api/execution/receipt` | Verify and reconcile a confirmed wallet transaction |
| `GET /rpc` | Machine-readable RPC reference |
| `POST /rpc` | Hookline methods |
| `POST /rpc/{chainId}` | Allowlisted Ethereum JSON-RPC proxy |
| `POST /rpc/paid` | x402-protected Hookline methods |

The public proxy does not submit transactions. It rejects write, account, administrative, debug, trace, and batch requests.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Security reports should follow [SECURITY.md](SECURITY.md) rather than being posted publicly.

Hookline is an independent project. It is not affiliated with or endorsed by Uniswap Labs, Robinhood, Flaunch, PayAI, or the upstream RPC providers.
