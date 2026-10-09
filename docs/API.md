# Hookline API reference

Base URL: `https://hookline.world`

## Hookline methods

All Hookline RPC requests use JSON-RPC 2.0 and require an `id` and array-valued `params`.

### `hookline_chains`

Returns supported chain IDs, names, upstream identifiers, and transaction-submission capability.

```json
{"jsonrpc":"2.0","method":"hookline_chains","params":[],"id":1}
```

### `hookline_decodePermissions`

Decodes the low 14 bits of a 20-byte address into canonical Uniswap v4 hook permission flags.

```json
{"jsonrpc":"2.0","method":"hookline_decodePermissions","params":["0x0000000000000000000000000000000000003fff"],"id":2}
```

### `hookline_chainStatus`

Returns current chain identity, latest block, latency, upstream, and status for a supported numeric chain ID.

```json
{"jsonrpc":"2.0","method":"hookline_chainStatus","params":[8453],"id":3}
```

### `hookline_getHook`

Returns live contract evidence for a supported chain and address.

```json
{"jsonrpc":"2.0","method":"hookline_getHook","params":[8453,"0xb08211d57032dd10b1974d4b876851a7f7596888"],"id":4}
```

## Public routes

Send Hookline methods to `POST /rpc`. Safe standard methods can be sent to `POST /rpc/{chainId}`.

The standard proxy allowlist includes chain identity, block, bytecode, storage, balance, transaction lookup, receipt, fee, gas-price, and estimation calls. It rejects transaction submission, account requests, debug, trace, personal, and administrative methods.

Constraints:

- Request bodies: 32 KiB maximum
- Upstream responses: 2 MiB maximum
- Upstream timeout: eight seconds
- Batches: rejected
- Public rate limit: best-effort 60 POST requests per IP per minute
- Cache policy: no-store for dynamic evidence

## x402 capacity

`POST /rpc/paid` exposes the Hookline methods through the official x402 Hono middleware.

| Field | Value |
| --- | --- |
| Scheme | `exact` |
| Network | `eip155:8453` |
| Asset | Base USDC |
| Amount | `10000` atomic units, or 0.01 USDC |
An unpaid, valid request receives HTTP `402` and a `Payment-Required` header. Malformed JSON-RPC is rejected before a payment challenge is created.

## Errors

Hookline uses JSON-RPC error envelopes. Important codes include:

- `-32700`: invalid JSON or body limit exceeded
- `-32600`: invalid JSON-RPC request
- `-32601`: unsupported or disallowed method
- `-32602`: invalid method parameters
- `-32029`: public rate limit exceeded

Upstream failures are returned as explicit errors and are not converted into successful evidence.

## Projects and contributions

| Route | Response |
| --- | --- |
| `GET /api/projects` | Registry, metadata provenance, sourced deployments, linked/monitored/observed counts |
| `GET /api/projects/{id}` | Project, latest pinned observations, exact-runtime relationships, retained events, per-target monitoring status, related categories |
| `GET /api/project-activity?project={id}&signal={signal}&focus={focus}&history={history}` | Canonical event feed with optional project, normalized mechanism-signal, evidence-type, and backfill filters; `signal` is `factory_launch`, `implementation_change`, `fee_configuration_change`, `runtime_change`, `configuration_change`, `outcome`, or `all`; `focus` is `important`, `configuration`, `outcome`, `accrual`, or `all`; and `history` is `all` or `current`. The response also includes an exact rolling `summary24h` for the selected project scope, independent of the 60-row feed limit and excluding backfill. |
| `GET /api/project-comparison?ids=clanker,pons` | Two to four known project records and observations using the same schema |
| `POST /api/project-submissions` | Private listing, suggestion, correction, or domain-claim receipt |

Project observations expose chain/address, source block/hash, observation time, field values, and probe status. Activity schema version 4 retains the deterministic `signalType` on each event and adds the independently aggregated `summary24h` without replacing original classifications or evidence. Null means unavailable, not zero. Configurations, decoded contract events, and outcomes must not be conflated. Comparisons preserve each chain and block; they are not normalized performance rankings. Coverage is bounded, not exhaustive. `generatedAt` on an API envelope is not the timestamp of every observation inside it.

Public snapshots are briefly cached. Private receipt, DNS verification, owner-metadata, and agent-review routes are authenticated and `no-store`. Receipt credentials belong in an authorization header, never in a URL. See [the full contribution API](PROJECT_CONTRIBUTIONS.md) for request bodies, limits, proof expiry, and review decisions.

`GET /api/v3/hook-markets?chainId={chainId}&address={hook}` resolves indexed pools and available market readings. Fee metadata contains `feeMode` (`static`, `dynamic`, `invalid`, or `unavailable`), a nullable `advertisedFeePercent`, and `feeSource`. A dynamic flag has no numeric current fee. These fields do not measure hook extraction.

## Hook Tape

The first Tape surface indexes the official Uniswap v4 PoolManager on Base at `0x498581ff718922c3f8e6a244956af099b2652b2b`.

| Route | Response |
| --- | --- |
| `GET /api/tape/status` | Pool and swap counts, finalized heads, live and historical cursors, gap or lag, scanner state, source contracts, and derivation versions |
| `GET /api/tape/pools?limit=50` | Newest saved PoolManager initialization records |
| `GET /api/tape/pools?hook={address}&limit=50` | Initialization records for one exact normalized hook address |
| `GET /api/tape/pools?cursor={block}:{logIndex}` | Older records using the prior response's opaque-compatible cursor value |
| `GET /api/tape/swaps?limit=50` | Newest finalized PoolManager swap records for resolved hooked pools |
| `GET /api/tape/swaps?hook={address}&limit=50` | Swap rows for one exact normalized hook address |
| `GET /api/tape/swaps?pool={bytes32}&limit=50` | Swap rows for one exact pool ID |
| `GET /api/tape/swaps?cursor={block}:{logIndex}` | Older swap rows using the prior response's cursor value |
| `GET /api/tape/activity?blocks=1800` | Per-hook swap, pool, sender, and PoolManager-fee summaries over an explicit retained block window |
| `GET /api/tape/activity?hook={address}&blocks=1800` | Per-pool activity and latest sourced PoolManager fee for one hook over the same window |

Each pool row contains the PoolManager, pool ID, hook, currencies, configured LP fee field, tick spacing, initial price and tick, block/hash, transaction/hash, log index, finalized read boundary, retained source log, and derivation version.

Each swap row contains the resolved hook and pool, currencies, sender, signed `amount0` and `amount1` pool deltas in raw token base units, post-swap price and liquidity fields, tick, the swap fee emitted by PoolManager, source block and transaction, retained raw log, finalized boundary, and derivation version. When its successful receipt has been normalized, the row also contains transaction gas and bounded ERC-20 `Transfer` logs that touch that hook or either pool currency. Each flow stays in raw token base units and carries `touchesHook` and `matchesPoolCurrency` relationship flags. When that receipt-backed transaction is selected for the bounded trace pass, the row also contains direct hook callback frames, callback selectors, decoded `beforeSwap`/`afterSwap` return deltas, a valid explicit LP-fee override when returned, hook-linked native value, and provider-reported direct hook call-frame gas. Call-frame gas is inclusive of descendants. A transfer or call frame is not automatically a hook fee, payout, or proof of intent. Activity responses state the requested and available block range, whether coverage is complete, and the first and last included blocks. Their fee minimum, maximum, and latest values are PoolManager-reported swap fees, not separately attributed hook fees. The selected traces contain successful transactions only; reverted attempts, refusal rates, and generalized recipient/fee attribution remain unavailable.

The pool scanner keeps a finalized live cursor current and advances a separate bounded historical cursor from the PoolManager deployment block. The swap scanner has an independent finalized live cursor and retains rows only when Hookline has already resolved the pool-to-hook relationship. Receipt enrichment is capped at 12 transactions per run, 1,024 receipt logs inspected, and 64 relevant transfers retained per transaction. Trace enrichment is capped at one receipt-backed transaction per run, 1,024 trace items inspected, and 64 relevant call frames retained per transaction. It prioritizes receipts with hook-linked ERC-20 transfers, then the newest eligible receipts. Raw swap rows have a seven-day and 200,000-row ceiling; orphaned receipt and trace rows are pruned with expired swaps. The status response publishes those limits and actual coverage. A cursor advances only after its decoded source rows are stored. Failed reads retain the last good evidence and cursor. Public Tape responses are briefly cacheable; the operator scan route is authenticated and never public. The public JSON-RPC proxy continues to reject trace methods.

## Private accounts

Account endpoints accept only the canonical `https://hookline.world` origin, use secure HttpOnly same-origin cookies, and return `Cache-Control: no-store`. They are not public cross-origin APIs. Writes require `X-Hookline-CSRF` from the authenticated session, except the browser-bound sign-in challenge and login. Signatures authorize identity, never spending.

| Route | Purpose |
| --- | --- |
| `POST /api/account/challenge` | `{address,chainId}` creates a ten-minute EIP-4361 challenge bound to this browser |
| `POST /api/account/login` | `{challengeId,signature}` consumes the challenge once and starts a seven-day session |
| `GET /api/account/session` | Authenticated account identity and CSRF token, or guest status |
| `POST /api/account/logout`, `/logout-all` | Revoke the current session or all sessions for this account |
| `GET`, `PUT /api/account/watchlists` | Private metadata document; PUT requires `{revision,watchlists}` |
| `GET`, `PUT /api/account/preferences` | Private slippage/presets; PUT requires `{revision,patch}` |
| `GET`, `POST`, `DELETE /api/account/telegram-link` | Read link status, issue a one-use ten-minute private-chat link, or unlink |

Writes use revision comparison; stale writes return 409, never last-write-wins. Watchlists permit up to 20 lists, 100 contracts per list, 500 total, and 256 KiB. Measurements and execution authority are rejected. Identity verification supports EOAs and deployed EIP-1271 contracts on the five inspection chains, with at most five fixed-endpoint RPC reads, a five-second deadline, and a pinned block/hash. A contract account is chain-bound; same-address wallets on different chains are not merged. No EIP-6492 deployment or simulation occurs.

Telegram links require an authenticated private user/chat/from match, are hashed at rest, expire, and are consumed once. Linking does not merge settings, delete alerts, or grant signing authority. Rate limits and bounded expiration cleanup protect the existing storage budget. No Privy plan, wallet creation, sponsorship, or order execution is enabled by this API.

## Reviewed execution routes

`GET /api/execution/status` returns current per-chain quote, fee, instant-rebate, and wallet-handoff capability.

`POST /api/execution/quote` accepts a chain, sell token, buy token, exact sell amount, taker, and slippage. An eligible response contains a public unsigned quote plus an opaque, short-lived execution intent. The fee recipient and provider credentials are never exposed.

`POST /api/execution/receipt` accepts only the opaque intent ID and transaction hash. Hookline reads the transaction and receipt from the configured chain RPC and records a receipt only when the successful onchain transaction exactly matches the intent. The endpoint is idempotent.

The execution API never accepts keys, seed phrases, signatures, or signed transactions, and it never broadcasts. Submission occurs only through the user's connected browser wallet.
