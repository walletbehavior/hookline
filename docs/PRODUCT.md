# Hookline product documentation

## Product definition

Hookline is the intelligence and coordination layer for onchain hooks. The initial wedge is Uniswap v4: hooks can introduce custom behavior at important points in a pool's lifecycle, but information about deployed hooks is fragmented across explorers, repositories, dashboards, and individual research threads.

Hookline gives that ecosystem a shared evidence model and a practical workstation.

## Current capabilities

### Board

The hook board is a cross-chain discovery surface for active deployed hook identities and hook ecosystem projects. It supports search, chain and capability filters, activity sorting, address-permission profiles, shareable profile URLs, filtered JSON exports, explorer links, inline live contract reads, and a direct handoff into local watchlists.

Discovery and aggregate pool and swap counts come from a timestamped v4.xyz community-indexer snapshot. The sync queries the activity leaders in every two-nibble address prefix, so coverage is broad but explicitly not exhaustive. Records without a deployed address remain visible as directory entries rather than being presented as chain evidence.

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

## Planned first-party event index

The current board supplies useful discovery before Hookline owns the complete event pipeline. The next data layer follows official PoolManager events to build a graph of:

```text
hook ↔ pools ↔ chains ↔ deployers ↔ code versions ↔ events
```

The index will associate initialized pools with their configured hook, aggregate swap and liquidity activity over explicit block ranges, retain reorganization-safe cursors, and make every derived metric reproducible from its source events.

## Trust model

Hookline does not claim that a permission is malicious or beneficial. It explains what is encoded, shows what was observed, and exposes enough provenance for another researcher to reproduce the result.

The long-term product advantage is not a private score. It is a dependable, queryable record of what hooks exist, what they are connected to, what changed, and how that conclusion was reached.
