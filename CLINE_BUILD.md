# Hookline product and build brief

## Position

Hookline is the intelligence layer for onchain hooks. It begins as the hooks analytics desk people use to inspect, verify, monitor, and compare programmable-liquidity contracts, then grows into the registry, alerting system, event index, and developer API that the ecosystem can build around.

The product must earn trust through attributable evidence. Direct chain observations, derived metrics, explorer metadata, and project-submitted information must remain visibly distinct.

## Current product

- Live contract evidence on Ethereum, Base, Arbitrum One, and Robinhood Chain.
- Canonical Uniswap v4 low-14-bit permission decoding.
- Named browser-persisted watchlists with bounded history.
- Same-chain evidence and permission comparisons.
- Explicit refresh controls with no background polling.
- Live chain health, height, and latency telemetry.
- Free RPC access and an x402 paid-capacity route.
- HKLN contract and service links presented as a compact supporting layer, not as the main interface.

## Interface direction

The interface should feel like a serious network-intelligence workstation: dense, calm, sharp, and legible. Use obsidian surfaces, bone text, acid-lime primary signals, cyan secondary signals, fine rules, square corners, restrained monospaced data, and strong information hierarchy. Avoid decorative hero art, heavy glow, excessive pills, fabricated charts, and unsupported activity claims.

The first viewport must answer four questions immediately:

1. What is Hookline?
2. What can I inspect right now?
3. Which chains are healthy?
4. Where can I save the evidence?

## Product expansion

Build the event-backed system of record around this graph:

`hook ↔ pools ↔ chains ↔ deployers ↔ code versions ↔ events`

Prioritize:

1. PoolManager event ingestion and hook-to-pool discovery.
2. Historical swap and liquidity activity with exact block ranges.
3. Change detection for bytecode, ownership, permissions, and dependencies.
4. Alerts for saved hooks and watchlists.
5. Searchable hook profiles with provenance and claimable project metadata.
6. API and x402 access to normalized records and derived metrics.
7. Team workspaces, exports, webhooks, and longer retention.

Uniswap v4 is the initial wedge. The underlying model should later support other programmable-liquidity systems without flattening chain-specific semantics.

## Quality rules

- Candidate identity is chain ID plus normalized contract address.
- Never present cross-chain state or block heights as directly comparable.
- Never insert untrusted strings through unsafe HTML APIs.
- Preserve the latest successful observation when a later refresh fails.
- Keep public-chain upstreams centralized and immutable.
- Reject transaction submission and unsafe JSON-RPC methods.
- Treat every metric as a sourced claim with a timestamp and scope.
- Do not display invented prices, balances, volume, users, partnerships, or returns.
- Keep keyboard focus, labels, live feedback, reduced motion, and narrow-screen behavior intact.

## Acceptance checks

- `node --check dist/app.js`
- `node --check worker/index.js`
- `node scripts/build-hookline-worker.mjs`
- `node scripts/test-hookline-worker.mjs`
- Desktop browser inspection of Observe, Watchlists, and Network.
- Live smoke checks for `/`, `/health`, `/metrics`, `/rpc`, and an unpaid `/rpc/paid` challenge.
- Apex and `www` domain behavior verified after DNS and certificate issuance.
