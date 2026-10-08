# Hookline product documentation

## Product definition

Hookline is the intelligence and coordination layer for onchain hooks. The initial wedge is Uniswap v4: hooks can introduce custom behavior at important points in a pool's lifecycle, but information about deployed hooks is fragmented across explorers, repositories, dashboards, and individual research threads.

Hookline gives that ecosystem a shared evidence model and a practical workstation.

The boards are the map. The shipped Projects layer shares configuration reads, selected activity, exact-runtime relationships, and changes across a broad ecosystem. The activity feed separates configuration, executed outcomes, transfers, deferred actions, and routine accrual records so one noisy event class cannot bury the signal. The shipped Hook Tape owns finalized Base pool-initialization and live swap evidence with exact source transactions. It also summarizes retained swaps over explicit block windows, ranks currently active hooks, alerts on material changes to the PoolManager-reported fee for the same resolved pool, attaches bounded receipt-level ERC-20 flows, and selects successful traces for hook callbacks, return deltas, LP-fee overrides, native value, and direct call-frame gas. Receipt flows and call frames remain observations, not automatic fee claims. The next derivations add failed-attempt coverage and defensible hook-level attribution.

## Current capabilities

### Board

The hook board is a cross-chain discovery surface for active deployed hook identities and hook ecosystem projects. It supports search, chain and capability filters, activity sorting, address-permission profiles, shareable profile URLs, filtered JSON exports, explorer links, inline live contract reads, and a direct handoff into local watchlists.

Discovery and aggregate pool and swap counts come from a timestamped v4.xyz community-indexer snapshot. The sync queries the activity leaders in every two-nibble address prefix, so coverage is broad but explicitly not exhaustive. Records without a deployed address remain visible as directory entries rather than being presented as chain evidence.

### Projects and shared activity

A project can span factories, hooks, implementations, fee recipients, model contracts, and pools. A token is optional. All projects use one registry, deployment identity, observation envelope, and change feed; project-specific readers fill that schema instead of spawning separate dashboards. Profiles also connect hook deployments to the exact-runtime map, while keeping bytecode identity separate from ownership, affiliation, configuration, and measured behavior.

Descriptions, domain-controlled team updates, direct configuration reads, contract events, and reconciled outcomes are distinct. A configured buyback allocation is not an executed buyback. A payment event is not proof of every reward being distributed. Runtime equality is a research hint, not proof of shared project ownership or a new launch.

Profiles disclose linked, monitored, and actually observed deployment counts. Selected targets rotate through bounded scans on the existing 10-minute schedule. Reorg checks, per-target cursors, backfill labels, and last-good observations keep partial coverage explicit. Public browsing uses cached snapshots rather than starting a new scan for every visitor.

Teams and users can submit through the website, API, or Telegram, without email. Expiring DNS challenges verify control of the researched domain for metadata edits only. Suggestions enter a private authenticated agent queue. That workstation-based reviewer can publish supported metadata, not rewrite financial evidence or grant a safety endorsement.

### Observe

The live inspector accepts a supported chain and contract address. Hookline reads deployed runtime bytecode, calculates a SHA-256 fingerprint, probes `owner()` when the contract supports it, decodes the canonical 14 hook permission bits, and records the latest observed block.

The output is evidence, not an endorsement. A contract existing at an address does not establish its safety, quality, adoption, or relationship to a named project.

### Watchlists

Users can create named lists, save inspected contracts, refresh one item or an entire list, search and filter, preserve bounded observation history, and import or export their local workspace as JSON.

Watchlists live in the browser. The current service does not require an account and does not upload the list to Hookline.

### Compare

Hookline compares contracts only when both identities are on the same chain. The comparison includes runtime-fingerprint status, owner-probe results, code size, observed blocks, and the complete permission delta.

Cross-chain state and block heights are not presented as directly comparable.

### Network and API

The network view reports current upstream health, block height, and latency. The JSON-RPC layer exposes Hookline-specific methods and a constrained proxy for safe Ethereum JSON-RPC calls.

The free route uses a best-effort request limit. The x402 route provides a machine-payable capacity path denominated in Base USDC.

### Reviewed execution

Supported market cards can request a short-lived 0x route bound to the connected wallet, chain, destination, calldata, value, and fee economics. Hookline shows a 1% gross fee, applies 0.3% cashback instantly, and collects a 0.7% effective fee. The user's browser wallet signs and submits; Hookline never receives wallet secrets and its backend never broadcasts.

Website slippage and amount presets are device-local. Telegram preferences belong to its private user identity, and an explicit handoff carries the selected settings. Sell percentages use exact integer arithmetic against the current wallet balance. Unsupported native/token input combinations stop rather than reinterpret units. Aggregated routes may use other pools; displaying a hook does not certify execution through it.

Saved priority-fee references and TP/SL profiles are not active transaction overrides or orders. User-owned smart accounts with constrained, revocable automation are planned. Wallet creation, transfers, bridging, and automatic orders are not part of this release.

After confirmation, Hookline fetches the transaction and receipt directly from the configured chain RPC. A receipt is recorded only when the onchain sender, destination, calldata, value, chain, and successful status match the stored intent. Duplicate reconciliation is idempotent.

## Evidence classes

Hookline keeps four evidence classes distinct:

1. **Direct chain observations**: bytecode, calls, blocks, logs, and transactions obtained from an RPC provider.
2. **Deterministic derivations**: permission decoding, fingerprints, normalized identities, and event aggregation derived from direct observations.
3. **Verified external metadata**: source verification, explorer records, and signed project claims with a named source.
4. **Project-submitted information**: descriptions, links, and manifests supplied by a project and labeled accordingly.

This separation prevents a project claim from being mistaken for chain evidence and prevents a derived score from being mistaken for a raw fact.

The board applies those classes visibly:

- Indexed hook identities and aggregate counts are attributed to the community index snapshot.
- Permission profiles are deterministic derivations from each address.
- Project records carry their metadata provenance.
- Live inspection is available only where Hookline has configured RPC coverage.

## First-party event index

The broad board remains a useful discovery surface. Hookline now also follows finalized `Initialize` events from the official Base PoolManager to begin an independently reproducible graph of:

```text
hook, pools, chains, deployers, code versions, events
```

Initialization rows associate pools with their configured hook, currencies, LP fee field, source block, transaction, and raw log. A separate finalized live cursor retains PoolManager swap rows for already-resolved hooked pools, including signed pool deltas and the fee emitted for each swap. Both cursors advance only after evidence is stored. Bounded receipt and successful-trace enrichment now sit on those rows; complete failed-attempt and fee-attribution derivations remain next.

## Hook Tape

The first tape is live on Base and expands only after its derivations are dependable. Initialization rows answer which pool, hook, currencies, LP fee configuration, block, and transaction established a relationship. Swap rows answer which known hooked pool traded, its signed PoolManager deltas, emitted swap fee, post-swap tick, and exact source transaction. The next derivations answer deeper execution questions:

- How many swaps touched this hook in the stated block range?
- How many attempts reverted during the hook path?
- What fee did the pool advertise?
- Did a return-delta capability participate in the settlement path?
- What hook-adjusted token flow can be measured from the available call and transfer evidence?
- Which address received measurable value?

The tape does not infer an exact hidden fee from permission bits. It publishes a fee delta or recipient only when transaction receipts, call traces, and token movements support the claim. Missing trace coverage is reported as unavailable rather than estimated.

Runtime fingerprint is a first-class identity key for this layer. Deployments with identical runtime bytecode form a reproducible family, while a changed runtime becomes a separate family even when the name is reused.

## Trust model

Hookline does not claim that a permission is malicious or beneficial. It explains what is encoded, shows what was observed, and exposes enough provenance for another researcher to reproduce the result.

The long-term product advantage is not a private score. It is a dependable, queryable record of what hooks exist, what they are connected to, what changed, and how that conclusion was reached.
