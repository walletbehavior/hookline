# Projects and mechanism evidence

## Release contract

Hooks and Tokens remain open discovery views. Projects is a separate, searchable
ecosystem view, not a replacement for the address-level board. Projects may have
multiple deployments and no token. Metadata and deployment relationships retain
their individual provenance. A name or runtime match is never proof of affiliation.

The project registry, pinned-block observations, and change records feed the same
public pages, API, and Telegram subscriptions. Chain reads happen on a bounded
schedule per deployment, never once per visitor or subscriber.

### Public API

- `GET /api/projects` returns `{schemaVersion:1, generatedAt, projects:[]}`.
- `GET /api/projects/:id` returns `{project, observations:[], events:[], related:[]}`.
- `GET /api/project-activity?project=:id` returns `{events:[], generatedAt}`.
- `POST /api/project-submissions` accepts free new-project, claim, and correction
  requests. It returns HTTP 201 `{id,status,receiptToken,message}`. Claims include
  an expiring DNS challenge; other requests begin at `pending_review`. Never
  publish private contact information or proof correspondence.

Project objects have `id`, `name`, `summary`, `category`, `website`, `sources`
(`{label,url}`), `provenance`, `deployments`, and `coverage`. Deployments have
`chainId`, `address`, `role`, `name`, `provenance`, `sourceUrl`, optional indexed
`pools`, `swaps`, and `indexedAt`. Counts are community-index snapshots, not
measured interval activity. Coverage is `{linkedDeployments,monitoredDeployments,
observedDeployments}`. Scheduled monitoring is not a completed observation.

An observation has `id`, `projectId`, `chainId`, `address`, `blockNumber`,
`blockHash`, `observedAt`, `source`, `fields`, and `status`. Fields contain direct
runtime fingerprint/length, optional implementation and owner, and versioned
project-reader configuration. Failed probes are unavailable, never zero. Failed
refreshes preserve the last successful observation. Reads are pinned to one block.

Events have `id`, `projectId`, `projectName`, `kind`, `title`, `observedAt`,
`chainId`, `address`, `before`, `after`, `evidence`, and optional `transactionHash`.
Poll-detected changes identify their observation interval; they do not invent an
exact transaction or time. A first read is a baseline, not a change alert.

### Contribution request

```json
{
  "kind": "project",
  "projectId": "",
  "name": "",
  "website": "",
  "description": "",
  "contracts": "",
  "contact": "",
  "proofUrl": "",
  "message": "",
  "agreement": true,
  "websiteTrap": ""
}
```

`kind` is `project`, `claim`, or `correction`. Claims require an existing project
and a researched canonical domain. Ownership requires its DNS TXT challenge;
a proof URL alone cannot establish ownership. Contact is optional and should be a Telegram handle, not
an email address. No email is required and no email is sent. Corrections require an existing project
and a message. Submission is not ownership verification. Approval is an operator
review with evidence, not a paid badge. An agent handles ordinary listing and
correction reviews through the authenticated API. Teams can propose metadata updates but
cannot edit measured data. Requests are bounded, rate limited, and private.

## Scope and boundaries

- Free submissions, claims, corrections, and basic profiles. No token gate.
- No paid placements or HKLN entitlements in this release.
- Clear distinction between researched metadata, community relationships, direct
  observations, configured fees, and measured payouts.
- Project readers enrich shared records. Project-specific dashboards are not
  required for basic coverage.
- Existing wallet execution is reused only on supported routes. A project being
  listed does not establish that all its markets can be traded through Hookline.
- Fee extraction and payout totals require receipt/log reconciliation. Do not
  infer these from permissions, configured percentages, or aggregate swap counts.
- Browsing performs no chain writes. Telegram holds no signing authority.

## Source-bound outcomes and provider limits

CLAUS readers are gated to the observed verified implementation. Configuration is read in raw ppm with a stated gross-ETH basis; accrued balances are not payouts. Buyback/burn events optionally carry `evidence.receiptProof`: `transfer_confirmed` requires the exact source log and matching token/from/to/amount transfer in the same successful, pinned transaction receipt. Otherwise the event remains `contract_reported`, with a reason. NFT payment events and FOMO transfers remain distinct from burns. ENGRAM accrued owner fees do not become paid totals.

Doppler readers are bound independently to the canonical Base and Robinhood Airlock addresses and to each deployment's documented source commit. Launch, migration, module-state, and fee-collection records share the common event envelope. The Airlock `poolOrHook` value remains labeled as such because its meaning depends on the selected pool initializer. Collection amounts stay raw token units, and the zero token address denotes native currency.

Angstrom reads are bound only to the verified Ethereum ControllerV1 deployment. The reader preserves the controller's distinction between fee configuration, an opaque batch update, pool removal, controller replacement, and node-set changes. Millionths remain millionths, and configured fees are not presented as amounts paid by a swap. The controller ABI never crosses onto the L1 hook, Base hooks, or L2 factory.

Collector transport uses immutable, method-specific provider lists. Fallback state providers must match the chain and pinned block hash. At most 240 actual HTTP requests and a 42-second wall budget cover a scan, including provider validation and receipt proofs; at most four burn receipts are checked. A rate limit respects cooldown and stops work rather than pretending a smaller log range solved it. Unavailable historical log providers leave visible cursor lag. No provider, visitor, or follow count can expand those limits.

## Acceptance

1. Broad registry, searchable by project, mechanism category, chain, or address.
2. Profiles link source records and exact chain-aware deployment pages.
3. Shared, timestamped observation and change history with bounded persistence.
4. Project follows use the same event records as the website.
5. Free forms persist private requests and explicitly show pending review.
6. No missing metric appears as zero, no failed scan erases evidence.
7. Repeated events are deduplicated; source-block conflicts invalidate evidence.
8. Mobile profiles and forms are usable without scrolling beneath the board.
