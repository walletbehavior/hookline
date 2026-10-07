# Hookline — Implementation Summary

Hookline is a static, single-page prototype: a multichain evidence observatory for Uniswap v4 hooks. It is a plain HTML/CSS/JavaScript artifact with **no build step, no network calls, no external assets, and no framework**. All code runs client-side in the browser.

## Local run command

The `dist/` directory is a self-contained static bundle. Serve it with a local HTTP server and open the URL in a browser:

```sh
python3 -m http.server 8890 --directory dist --bind 127.0.0.1
```

Then visit `http://127.0.0.1:8890/` (or `http://localhost:8890/`).

Syntax-validation of the application script is done with Node's parser only:

```sh
node --check dist/app.js
```

## Static architecture

Three files in `dist/` form the entire deployable:

- `dist/index.html` — semantic markup with landmarks (`header`, `main`, `section`, `aside`, `footer`), visible status bar, a skip-link, hash-based navigation, the three views, and the creator-fee estimator.
- `dist/styles.css` — plain CSS, no framework; obsidian-black/bone-white surfaces with acid-lime and cyan signal colors, a fine grid/rule system, sharp corners, and responsive breakpoints down to 390px.
- `dist/app.js` — self-contained IIFE (`'use strict'`) that drives state, rendering, actions, and WebMCP registration.

### Views

Hash-based routing (`#observatory`, `#compare`, `#network`) behind `loadViewFromHash()` and `hashchange`:

1. **Observatory** — chain filter, watchlist (max 10), "add watch candidate" form (chain + 0x+40-hex validation), candidate detail card, simulated observations appended to an evidence timeline, and runtime permission-flag decoding.
2. **Compare** — two candidate selectors; same-chain comparisons show permission deltas, block delta, fingerprint match/mismatch, and selector-probe differences. Cross-chain selections are refused with a message that state and block heights are not comparable, optionally showing a non-authoritative code-family hint.
3. **Network** — launch thesis and creator-fee estimator (1% total fee × 80% launcher share = volume × 0.008) with seed buttons and an illustrative scenario table, plus external reference links.

### Demo chains

`dist/app.js` declares four supported chains via `CHAINS`: Ethereum (1), Base (8453), Arbitrum One (42161), Robinhood Chain (4663). The seed data includes a same-chain fingerprint-pair on Base (`fp_base_shared`) whose two candidates return different `owner()` selector values, demonstrating that fingerprint matches are only hints.

## Identity and storage model

Identity is **chain ID plus contract address**. Every candidate is keyed by a normalized composite key built as:

```js
`${String(chainId)}:${String(address).toLowerCase()}`
```

(see `candidateKey()`). This key is used everywhere: watchlist deduplication, selection state, compare select options, and the WebMCP `compare_candidates` tool.

All user-managed state lives in **`localStorage`** under the key `hookline:watchlist:v1` (`WATCHLIST_KEY`):

- `getWatchlist()` / `saveWatchlist()` wrap `localStorage.getItem` / `setItem` in `try/catch` to degrade gracefully when storage is unavailable (private/incognito mode or quota limits), keeping an in-memory `state.watchlist` copy.
- On first load, `seedDemoData()` restores the persisted watchlist, or falls back to the bundled `DEMO_CANDIDATES` (four to six fictional candidates) if none exists.
- Adding a candidate (`addCandidateInternal`) validates chain ID, then the address, rejects duplicates by key, and enforces the maximum of 10 candidates.
- Selected, compared, and view state live only in the in-memory `state` object; they are not persisted.
- The public inspection surface `window.Hookline` exposes `getState`, `decodePermissions`, `validateAddress`, `addCandidateInternal`, and `compareCandidates`.

## Fictional demo-data disclaimer

Everything in `dist/` is clearly marked as fictional demo data generated locally:

- HTML metadata (`<meta name="description">`), the system status bar ("TOKEN NOT LIVE", "demo data only"), candidate objects, simulation timestamps, generated fingerprints/blocks/transactions, and the fee estimator all state that no live RPC reads, live prices, balances, partnerships, or returns exist.
- The footer repeats that all evidence, candidates, blocks, transactions, and fee figures are fictional demo data.
- Simulation is the only state mutation: "Simulate new observation" appends a synthetic evidence-timeline entry; the creator-fee estimator is labeled "estimate only" and explicitly notes creator fees require trading volume and are not guaranteed revenue.

## WebMCP tools (three)

The app feature-detects `navigator.modelContext.registerTool` and registers exactly three imperative tools (declarative WebMCP markup is not used). Registration failures are caught and logged but never fatal:

1. **`decode_hook_address`** (read-only, `annotations: { readOnly: true }`)
   - Inputs: `chainId` (integer, enum 1 / 8453 / 42161 / 4663) and `address` (`0x` + 40 hex).
   - Returns identity (`chainId`, `chainName`, `address`, `addressBits`) plus all 14 decoded permission flags (`flag`, `enabled`, `bit`), decoded from the low 14 address bits in canonical Uniswap v4 bit order.

2. **`add_watch_candidate`** (destructive, `annotations: { destructive: true }`)
   - Inputs: `chainId`, `address` (`0x` + 40 hex), optional `label`.
   - Calls `addCandidateInternal`, applying the same chain/0x-40 validation, duplicate-key deduplication, and 10-candidate limit as the UI form.

3. **`compare_candidates`** (read-only, `annotations: { readOnly: true }`)
   - Inputs: `leftKey` and `rightKey` in `CHAIN_ID:lowercaseAddress` format.
   - Returns the same-chain comparison object or an explicit cross-chain refusal (`ok: false`) with the candidate pair and an optional non-authoritative code-family hint.

## Current launch assumptions

- **Status**: `DESIGN PHASE — TOKEN NOT LIVE`. Symbol `HKLN` is provisional; no claim of uniqueness is made.
- **Launch chain**: preferred ecosystem is Robinhood Chain, but the Flaunchy venue is selecting between Base and Robinhood Chain; which one launches is undecided and not promised.
- **No-wallet/no-gas** is a launch thesis under design, not a guarantee; creator fees require trading volume and are not guaranteed revenue; market cap itself does not produce fees (creator-fee estimator uses `volume × 0.008`).
- **Reputation is tracked separately from token balance**.
- Evidence flywheel: public hook evidence → trusted monitoring → paid capacity/API/adapter work → bounded contributor bounties → more verified chains → more useful evidence.
- No live data of any kind: no RPC reads, no live prices/balances, no partnerships, no legal or safety claims.

## Quality constraints

- HTML-escape every user-supplied string (`esc()`) before inserting into the DOM.
- Keyboard-accessible watchlist items (Enter/Space), visible focus, `aria-live` toasts, labels for every control, no color-only meaning, no horizontal overflow below 390px.
- Validation is shared between the UI form and the WebMCP tools (`validateAddress`, `validateChainId`).

