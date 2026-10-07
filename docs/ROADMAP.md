# Hookline roadmap

The roadmap separates shipped work from planned work. Sequence can change as chain support, upstream reliability, and user demand become clearer.

## Now: dependable evidence desk

Status: operating in production.

- Live contract inspection on four chains
- Permission decoding and runtime fingerprints
- Owner-probe status
- Named local watchlists and evidence history
- Same-chain comparisons
- Chain telemetry
- Free JSON-RPC and x402 paid capacity
- Public product, API, architecture, and data-provenance documentation

Acceptance criteria:

- Every successful observation carries chain, address, block, timestamp, and source scope.
- Failed refreshes preserve prior successful evidence.
- Transaction submission remains unavailable.
- Public claims contain no fabricated usage or market data.

## Next: hook registry and pool graph

- Index PoolManager initialization events on the first production chain
- Build canonical hook-deployment and pool identities
- Store raw logs and reorganization-safe cursors
- Publish searchable hook and pool profiles
- Add verified-source and deployer metadata with provenance
- Expose indexed records through the API

Acceptance criteria:

- Every pool relationship resolves to its originating transaction and block.
- The index can rebuild its derived state from retained source data.
- Project-submitted profiles are visibly separate from chain observations.

## After that: activity and change intelligence

- Index swaps, liquidity modifications, and donations
- Add explicit block-range activity metrics
- Detect runtime, owner, permission, and dependency changes
- Add saved-search and watchlist alerts
- Provide activity, change, and dependency timelines
- Add CSV and JSON dataset exports

Acceptance criteria:

- Each metric displays chain, block range, generated time, and derivation version.
- Alerts link to the before and after evidence.
- Reorganizations produce deterministic corrections rather than duplicate activity.

## Professional layer

- Account-backed watchlists and team workspaces
- Email, webhook, and agent-delivered alerts
- Longer retention and bulk history
- Higher API capacity and API keys
- Service-health history and status communication
- Signed project manifests and claimable profiles

Acceptance criteria:

- Free inspection remains useful.
- Paid limits correspond to measurable infrastructure cost or professional workflow value.
- Team data has explicit ownership, export, and deletion behavior.

## Ecosystem layer

- Additional v4 deployments and chains based on demonstrated demand
- Adapters for other programmable-liquidity systems
- Public evidence schema and manifest specification
- Research contributions with attribution
- Agent tools for discovery, monitoring, and paid evidence queries

Expansion will preserve protocol-specific semantics. Hookline will not label unrelated mechanisms as equivalent merely to increase chain or protocol counts.
