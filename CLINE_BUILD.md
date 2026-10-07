# Cline build brief: Hookline v1

Build the entire deployable prototype in this repository. Work only in `dist/` and `IMPLEMENTATION.md`; preserve `.openai/hosting.json` and all other starter files. This is a static site with no network calls, no package install, and no external assets.

## Product

Hookline is a multichain evidence observatory for Uniswap v4 hooks. Candidate identity is always chain ID plus contract address. Every evidence record must visibly retain chain, block number, and transaction hash. Never compare live state across chains. All data in this prototype is clearly marked fictional/demo data.

Supported demo chains:

- Ethereum — chain ID 1
- Base — chain ID 8453
- Arbitrum One — chain ID 42161
- Robinhood Chain — chain ID 4663

Views are Observatory, Compare, and Network. The app must be usable in the first viewport and fully responsive down to 390px without horizontal page overflow.

## Output

Create:

- `dist/index.html`
- `dist/styles.css`
- `dist/app.js`
- `IMPLEMENTATION.md`

Use plain HTML/CSS/JavaScript. No build step. No CDN, webfont, image, framework, external script, or external stylesheet. Include an inline data-URL favicon. Add only imperative WebMCP registration behind feature detection; do not use declarative WebMCP markup.

## Visual direction

A forensic ledger / network intelligence terminal, not a generic crypto landing page. Obsidian-black and bone-white surfaces, acid-lime primary signal, cyan secondary signal, fine grid/rule system, sharp corners, restrained mono data typography, clear hierarchy. No gradients, heavy glows, pills everywhere, or decorative hero art. It should feel credible, dense, calm, and original.

## Observatory behavior

- Sidebar or top rail with a real chain filter and a watchlist of candidates.
- Seed at least four fictional candidates, including Robinhood Chain and Base.
- Include two candidates on the same chain that share the same runtime bytecode fingerprint but return different values for an `owner()` selector probe, so the UI demonstrates why fingerprint matches are only hints.
- Form to add a watch candidate with chain and 0x + 40 hex-character address validation.
- Persist at most 10 candidates in localStorage, keyed by chain ID plus lowercase address. Prevent duplicates.
- Select, simulate a new observation, and unfollow. Simulated observations append evidence history rather than overwriting it.
- Decode the low 14 address bits into the canonical Uniswap v4 hook permission flags, in this bit order from high to low: beforeInitialize, afterInitialize, beforeAddLiquidity, afterAddLiquidity, beforeRemoveLiquidity, afterRemoveLiquidity, beforeSwap, afterSwap, beforeDonate, afterDonate, beforeSwapReturnDelta, afterSwapReturnDelta, afterAddLiquidityReturnDelta, afterRemoveLiquidityReturnDelta.
- Show evidence timeline entries with chain, block, transaction hash, timestamp, runtime fingerprint, and selector probe values.
- Add compact accessible status/toast feedback and keyboard-visible focus.

## Compare behavior

- Two candidate selectors.
- Allow comparisons only when both candidates have the same chain ID. For cross-chain selection, render a clear refusal explaining that state and block heights are not comparable; allow only a non-authoritative code-family hint.
- For valid comparisons, show permission deltas, latest block delta, fingerprint match/mismatch, and selector-probe differences.

## Network behavior

Present the launch thesis accurately and conservatively:

- Status: `DESIGN PHASE — TOKEN NOT LIVE`.
- Provisional symbol: HKLN. Do not claim uniqueness.
- Preferred ecosystem: Robinhood Chain, but the Flaunchy venue currently selects a live launch chain between Base and Robinhood Chain; do not promise which one.
- No-wallet/no-gas launch thesis, with a visible caveat that creator fees require trading volume and are not guaranteed revenue.
- Show the flywheel: public hook evidence -> trusted monitoring -> paid capacity/API/adapter work -> bounded contributor bounties -> more verified chains -> more useful evidence.
- Reputation remains separate from token balance.
- Include an interactive creator-fee estimator using a 1% total trading fee and an 80% launcher share, so estimated launcher fees equal cumulative trading volume times 0.008. Inputs: market cap and volume multiple. Seed buttons for $30k, $100k, $500k market cap and 0.5x, 1x, 3x, 10x volume multiples. Label all results estimates, denominated in USD-equivalent, with payout described as ETH per current venue documentation. Do not imply market cap itself produces fees.
- Include a small scenario table matching:
  - 30k MC: $120 at 0.5x volume, $240 at 1x, $720 at 3x, $2,400 at 10x
  - 100k MC: $400, $800, $2,400, $8,000
  - 500k MC: $2,000, $4,000, $12,000, $40,000
- Include external text links to official Flaunchy FAQ and Flaunchy docs, using `target=_blank` and safe rel attributes. Do not imply affiliation with Robinhood, Flaunch, or Uniswap.

## WebMCP

Feature-detect `navigator.modelContext.registerTool`. Register exactly these imperative tools when available:

- `decode_hook_address`: read-only; input chainId and address; returns identity and all decoded permissions.
- `add_watch_candidate`: local state-changing; input chainId, address, optional label; performs the same validation and 10-candidate limit as the UI.
- `compare_candidates`: read-only; input leftKey and rightKey; returns same-chain comparison or explicit cross-chain refusal.

Use JSON-schema-style input schemas and appropriate read-only/destructive annotations. Make registration failures non-fatal.

## Quality bar

- Semantic landmarks and headings, labels for every control, aria-live feedback, no color-only meaning, sensible tab order.
- Hash-based navigation so view state is deep-linkable.
- Escape all user-provided strings before inserting HTML; avoid unsafe dynamic HTML patterns when practical.
- No invented live prices, balances, RPC reads, partnerships, returns, safety claims, or legal claims.
- Keep code readable and comment only where behavior is subtle.
- Validate with `node --check dist/app.js` and a lightweight static-file sanity check. Fix any failures before reporting completion.

In `IMPLEMENTATION.md`, summarize architecture, local run command, storage model, demo-data disclaimer, WebMCP tools, and known launch assumptions. Implement the files—do not merely describe them.
