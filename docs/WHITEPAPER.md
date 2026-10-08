# Hookline: an evidence and coordination layer for onchain hooks

Version 0.2, October 7, 2026

## Abstract

Programmable-liquidity hooks turn pool behavior from a fixed implementation detail into an extensible surface. That flexibility creates a discovery and coordination problem: hook deployments, pool relationships, permissions, code versions, ownership, activity, and project claims are scattered across chains and tools that were not designed around hooks as a first-class object.

Hookline proposes a neutral evidence layer for this ecosystem. It begins with live, reproducible contract observations and grows into an event-backed system of record, monitoring network, research terminal, and developer API. The goal is not to replace explorers or declare contracts safe. The goal is to make the state and history of hooks easier to discover, verify, compare, and consume.

## 1. The coordination problem

A developer evaluating a hook commonly needs to answer several questions:

- Which chain and exact address identify this deployment?
- What runtime code is deployed there now?
- Which callbacks are encoded in the address?
- Does a conventional ownership probe succeed?
- Which pools use the hook?
- What swap and liquidity activity flows through those pools?
- Has the code, owner, configuration, or activity changed?
- Is a label direct evidence, verified metadata, or a project claim?

Today those answers may require an explorer, source repository, custom RPC calls, an indexer, a dashboard, and social context. The resulting research is hard to reproduce and often loses the block range or chain identity that made the conclusion meaningful.

Hookline treats the hook deployment as the primary research object and gives every observation a consistent identity and provenance envelope.

## 2. Design principles

### Evidence before interpretation

Hookline records what was observed before attaching a label, rating, or narrative. Runtime bytecode, call results, logs, blocks, and transactions remain distinguishable from deterministic derivations and third-party metadata.

### Chain-aware identity

An address is not a complete identity. Hookline keys contracts by chain ID plus normalized address. The same hexadecimal address on two chains can contain unrelated code and state.

### Reproducible derivations

Permission flags, fingerprints, activity totals, and change records should be reproducible from disclosed inputs. Derived metrics include their chain, block range, timestamp, and method.

### Failure is evidence

An RPC timeout, reverted owner probe, unavailable upstream, or failed refresh is shown as failure. It does not erase the last successful observation or become an empty success value.

### Bounded cost by default

The browser performs no continuous background polling. Public access is constrained, expensive work can move behind paid capacity, and event ingestion will use durable cursors rather than repeated full-range scans.

## 3. Current architecture

The current release is a single Cloudflare Worker with an embedded browser application and JSON-RPC service.

The browser provides the inspector, named watchlists, same-chain comparisons, telemetry, import and export, and optional WebMCP tools. Watchlist state is local to the browser.

The Worker centralizes supported upstreams, validates JSON-RPC envelopes, applies request and response limits, calls the selected chain, calculates runtime fingerprints, probes conventional ownership, and decodes permissions. The proxy exposes only explicitly allowed methods and never submits a transaction.

The x402 route separates machine-payable capacity from public access. Payment terms are advertised in a standard HTTP 402 challenge and settle in Base USDC.

The Projects release adds a broad sourced registry, shared block-pinned observations, selected contract-event readers, a signal-filtered common change feed, and exact-runtime relationships. Deployment coverage is explicit. A project may represent a launch platform, liquidity mechanism, tokenized experiment, or developer tool; it need not have a token. Readers attach factory, controller, implementation, fee, recipient, model, and distribution observations to common objects rather than inventing a separate dashboard for every integration. Doppler's source-bound Airlock reader demonstrates the shared model across Base and Robinhood Chain without assuming every emitted pool-or-hook address is a v4 hook. Angstrom demonstrates the same schema for an operational controller whose authority, pool configurations, and node set are distinct from the hook address.

Private submissions and expiring DNS domain claims support team-authored metadata without granting control over observations. A scheduled authenticated reviewer can process ordinary requests against primary sources. Claims, paid services, and execution volume do not rank or alter the evidence feed.

The configured monitoring targets rotate through the existing 10-minute trigger. Retained event windows, cursor lag, unavailable RPC responses, and reorganization handling are visible. This shared layer is shipped; complete PoolManager indexing, extracted-fee attribution, refusal-rate measurement, and outcome reconciliation are still planned.

## 4. The event-backed system of record

Point-in-time contract evidence is necessary but insufficient for analytics. Hookline's next layer indexes official PoolManager events into a normalized graph:

```text
HookDeployment
  ├── CodeVersion
  ├── OwnershipObservation
  ├── PermissionSet
  ├── PoolRelationship
  │     ├── Initialize
  │     ├── Swap
  │     ├── ModifyLiquidity
  │     └── Donate
  └── ProjectProfile
```

An initialization record establishes the pool-to-hook relationship at a specific chain and block. Subsequent pool events can then be attributed to that relationship over explicit block ranges. Reorganization handling, cursor checkpoints, and raw-log retention allow the derived state to be rebuilt.

This model supports useful questions without pretending that raw volume is the whole story:

- Which hooks are connected to active pools?
- Which deployments share a runtime fingerprint?
- Which callback combinations are common?
- Which hooks changed owner or runtime code?
- Which pools depend on a particular deployment?
- Which contracts stopped producing activity?
- Which project claims match verified source and direct observations?

## 5. Product surfaces

### Registry

A searchable record of hook deployments, code versions, permissions, owners, pool relationships, source status, and project claims.

### Analytics desk

A human workstation for inspection, history, comparisons, activity, dependency views, and reproducible exports.

### Hook Tape

A first-party feed begins with finalized Base PoolManager initialization evidence. Pool rows resolve the pool, hook, currencies, configured LP fee field, block, transaction, raw log, and derivation version. A separate finalized live cursor retains Swap logs for already-resolved hooked pools, including signed pool deltas, the fee emitted by PoolManager, post-swap state, and exact transaction evidence. A bounded receipt pass keeps normalized ERC-20 transfers that touch the saved hook or a pool currency. A smaller successful-transaction trace pass retains direct hook callback frames, decodes swap return deltas and explicit LP-fee overrides, and records relevant native value plus provider-reported direct call-frame gas. Those transfers and frames are observable evidence, not automatic fee attribution. Explicit block-window summaries identify activity leaders and whether the retained range fully covers the request. The next trace layer adds failed-attempt coverage, defensible hook deltas, refusal-rate windows, and recipients only when they can be proven.

Runtime fingerprints group byte-identical deployments into runtime families. Identical code alone does not establish identical configuration, common ownership, or a new launch. Proxy implementation and model-address reads are separate identity signals. The evolving tape combines those signals without treating a family badge as measured behavior.

### Monitoring and alerts

Hook profiles support bounded Telegram alerts for direct runtime changes, newly indexed pool relationships, material PoolManager fee moves for the same finalized pool, and material indexed-liquidity movement across a stable, fully measured pool set. Fee alerts preserve the distinction between PoolManager's emitted swap fee and a separately proven hook charge. Project follows use the shared configuration-change and decoded-event feed. Backfill is not promoted to newly occurring activity. Deeper outcome, dependency, family, and upstream-health subscriptions remain planned.

### Reviewed execution

Where a supported market exposes an eligible route, Hookline binds an unsigned transaction to a short-lived intent and hands it to the user's wallet. A 1% gross fee includes 0.3% instant cashback, so the route collects 0.7% rather than creating a deferred reward promise. Hookline independently reconciles the confirmed transaction against the stored intent. Execution volume never determines which evidence or alerts exist.

### Developer infrastructure

JSON-RPC, REST or GraphQL exports where useful, webhooks, manifests, and machine-payable queries. The exact interface should follow demonstrated use rather than multiplying protocols prematurely.

### Research network

Claimable project profiles, signed manifests, contributed labels, reproducible notebooks, and attribution for researchers. Submitted information remains distinct from observed data.

## 6. Sustainability

The public product should remain useful without a token or paid account. Sustainable revenue can come from costs that increase with professional use:

- longer historical retention
- high-frequency alerts and webhooks
- larger watchlists and team workspaces
- bulk exports and normalized datasets
- higher API limits and service guarantees
- x402 queries for autonomous agents
- integration and adapter work
- reviewed execution with a plainly disclosed 0.7% effective fee

## 7. Risks and limitations

RPC providers can fail, throttle, lag, or disagree near the chain tip. Conventional probes such as `owner()` are not universal. Address permission bits describe enabled callbacks but do not explain the full behavior of runtime code. Verified source can be absent or stale. Event-derived metrics can be wrong if an indexer misses logs or mishandles a reorganization. Project-submitted metadata can be misleading.

Hookline mitigates these risks through explicit provenance, retained block scope, error visibility, rebuildable derivations, multiple evidence classes, and conservative language. It cannot eliminate smart-contract risk and should not be treated as an audit or trading recommendation.

## 8. Path to a standard

Hookline becomes infrastructure only if other people can rely on its identities and reproduce its claims. The path is therefore incremental:

1. Make direct inspection dependable.
2. Publish a stable evidence schema.
3. Index official events with rebuildable state.
4. Expose history and alerts.
5. Support signed project manifests and attributed research.
6. Let agents and applications consume the same records through paid and public interfaces.

The desired outcome is a shared language for answering what a hook is, where it is deployed, what it can do, what depends on it, what changed, and where the evidence came from.
