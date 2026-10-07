# Hookline roadmap

The roadmap separates shipped work from planned work. Sequence can change as chain support, upstream reliability, and user demand become clearer.

## Now: dependable evidence desk and reviewed execution

Status: operating in production.

- Live contract inspection on five chains
- Cross-chain hook board and project directory
- Broad Projects board with source-linked, chain-aware deployment relationships
- Shared pinned-state observations and selected project mechanism event readers
- Source-linked project activity, scan-coverage disclosure, and Telegram follows
- Free API, website, and Telegram submissions, corrections, and DNS domain claims
- Metadata-only team updates, private receipts, and agent review with audit history
- Timestamped indexed pool and swap aggregates
- Permission decoding and runtime fingerprints
- Owner-probe status
- Named local watchlists and evidence history
- Optional wallet-message sign-in, explicit private watchlist/settings save and load, and one-use Telegram identity linking
- Google/email login, opt-in embedded EVM wallets, secure export, and external-wallet selection
- Source-bound CLAUS allocations, accrued balances, and mechanism events, with bounded same-receipt burn-transfer confirmation
- Telegram alerts for direct runtime changes, new indexed pool relationships, and 10% indexed liquidity changes
- Named alert cards, full copyable contract addresses, and button-first navigation
- Saved slippage and amount preferences; exact current-balance percentage sizing
- Same-chain comparisons
- Chain telemetry
- Free JSON-RPC and x402 paid capacity
- Fee-bound 0x routes on supported EVM markets
- User-wallet signing and submission with exact intent binding
- 1% gross fee, 0.3% instant cashback, and 0.7% effective collection
- Independently reconciled, idempotent execution receipts
- Public product, API, architecture, and data-provenance documentation

Saved priority-fee references and TP/SL profiles are configuration only, not
transaction overrides or active orders. Monitoring coverage and current
limitations are listed in the [October 7 release notes](RELEASE_2026-10-07.md).

Acceptance criteria:

- Every successful observation carries chain, address, block, timestamp, and source scope.
- Failed refreshes preserve prior successful evidence.
- Hookline's backend never signs or broadcasts; only the user's connected wallet can submit the reviewed transaction.
- A receipt is stored only after the onchain transaction matches the short-lived intent's wallet, chain, destination, calldata, and value.
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

## After that: deeper route checks and change intelligence

- Compare pool price with the hook-adjusted execution result before user signing
- Add measured hook fees beside the already-live Hookline fee and instant rebate
- Detect runtime, owner, permission, and dependency changes
- Add saved-search, runtime-family, and watchlist alerts
- Provide activity, change, and dependency timelines
- Add CSV and JSON dataset exports
- Extend the shared execution interface with reviewed funding and bridging flows
- Add limit and TP/SL execution only after order lifecycle, cancellation,
  trigger pricing, and explicit user-controlled signing permissions are implemented

The intended automated-order design is a user-owned smart account. The user
retains owner and recovery control; any automation permission must be explicit,
revocable, time-limited, and restricted by chain, router, assets, recipient,
spend limits, and transaction parameters. A saved Telegram profile grants no
permission. Withdrawals, bridges, owner changes, and arbitrary contract calls
are outside a trading permission. Provider, chain, recovery, and policy support
must be verified before this becomes an active product capability. There is no
unrestricted bot-owned wallet or automatic order service in the current release.

Acceptance criteria:

- Each metric displays chain, block range, generated time, and derivation version.
- Alerts link to the before and after evidence or the exact tape range.
- Reorganizations produce deterministic corrections rather than duplicate activity.

## Professional layer

- Team workspaces and shared account-backed workflows beyond explicit personal save/load
- Webhook and agent-delivered alerts
- Longer retention and bulk history
- Higher API capacity and API keys
- Service-health history and status communication
- Signed contract/deployment manifests beyond the shipped domain-controlled profiles

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
