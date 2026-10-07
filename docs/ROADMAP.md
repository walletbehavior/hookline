# Hookline roadmap

The roadmap separates shipped work from planned work. Sequence can change as chain support, upstream reliability, and user demand become clearer.

## Now: dependable evidence desk

Status: operating in production.

- Live contract inspection on five chains
- Cross-chain hook board and project directory
- Timestamped indexed pool and swap aggregates
- Permission decoding and runtime fingerprints
- Owner-probe status
- Named local watchlists and evidence history
- Telegram alerts for new hook pools and 10% aggregate liquidity changes
- Same-chain comparisons
- Chain telemetry
- Free JSON-RPC and x402 paid capacity
- Public product, API, architecture, and data-provenance documentation

Acceptance criteria:

- Every successful observation carries chain, address, block, timestamp, and source scope.
- Failed refreshes preserve prior successful evidence.
- Transaction submission remains unavailable.
- Public claims contain no fabricated usage or market data.

## Next: Hook Tape and runtime families

- Index PoolManager initialization events on the first production chain
- Build canonical hook-deployment and pool identities
- Store raw logs and reorganization-safe cursors
- Index swap outcomes and hook calls over explicit block ranges
- Measure the pool-advertised fee separately from observable hook-adjusted token flow
- Record swap refusals, hook gas, recipients, and return-delta involvement where the evidence supports it
- Keep the shipped runtime-family map current and identify changed forks as separate families
- Publish short tape rows with links to their source transactions, logs, traces, and derivation version
- Alert on material fee deltas, refusal-rate changes, and new deployments of known runtime families

Acceptance criteria:

- Every pool relationship resolves to its originating transaction and block.
- Every tape metric identifies the exact chain, hook, pool, and block range.
- Pool fee, hook delta, and measured token flow remain separate fields.
- A metric is withheld when the available receipt or trace cannot support it.
- Runtime-family membership is reproducible from retained bytecode and its fingerprint.
- The index can rebuild its derived state from retained source data.
- Project-submitted profiles are visibly separate from chain observations.

## After that: route checks and change intelligence

- Compare pool price with the hook-adjusted execution result before user signing
- Show hook fees and Hookline execution fees in one preview
- Detect runtime, owner, permission, and dependency changes
- Add saved-search, runtime-family, and watchlist alerts
- Provide activity, change, and dependency timelines
- Add CSV and JSON dataset exports

Acceptance criteria:

- Each metric displays chain, block range, generated time, and derivation version.
- Alerts link to the before and after evidence or the exact tape range.
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
