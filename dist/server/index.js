/* ==========================================================================
   Hookline — public JSON-RPC layer for Cloudflare Workers

   This is the maintainable runtime source. The build step
   (scripts/build-hookline-worker.mjs) reads dist/index.html, dist/styles.css
   and dist/app.js, embeds them with JSON.stringify and emits a single
   self-contained artifact at dist/server/index.js.

   Export contract: default.fetch(request, env, ctx) — the Cloudflare Worker
   entry point. The same module also runs under Node (v22+) with
   `node --check` and with `node <file>`, which is how the local validator
   exercises it.

   Security posture
   ----------------
   * Safe by construction: the standard proxy allowlists only
     non-write methods; eth_sendTransaction / eth_sendRawTransaction are
     rejected.
   * Upstreams are immutable, centralized constants. The request body may
     never influence which upstream is contacted (never accept an upstream
     URL).
   * Upstream requests time out after 8 seconds.
   * Bodies are capped at 32 KiB.
   * JSON-RPC batches are rejected.
   * All responses carry CORS + hardened security headers; cache is
     controlled per-route.
   ========================================================================== */

import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { facilitator as payAiFacilitator } from '@payai/facilitator';

'use strict';

// ---------------------------------------------------------------------------
// Static assets (public bundle) — injected by scripts/build-hookline-worker.mjs
// via JSON.stringify over dist/index.html, dist/styles.css and dist/app.js.
// The build script replaces the marker below verbatim with the embedded assets.
// ---------------------------------------------------------------------------
const ASSETS = Object.freeze({
  html: "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <meta name=\"theme-color\" content=\"#0b0e12\">\n  <meta name=\"description\" content=\"Hookline is the intelligence layer for onchain hooks: live contract evidence, multichain watchlists, comparisons, telemetry, and developer access.\">\n  <title>Hookline | Onchain Hooks Intelligence</title>\n  <link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230b0e12'/%3E%3Cpath d='M38 8v27c0 11-6 17-15 17-7 0-12-4-12-10 0-6 5-10 11-10 4 0 7 1 9 4V8h7zm0 4h15v8H38' fill='none' stroke='%23c8f73c' stroke-width='6'/%3E%3C/svg%3E\">\n  <link rel=\"stylesheet\" href=\"styles.css\">\n</head>\n<body>\n  <a class=\"skip-link\" href=\"#main\">Skip to main content</a>\n\n  <header class=\"top-bar\" role=\"banner\">\n    <div class=\"top-inner\">\n      <a class=\"wordmark\" href=\"#/observatory\" aria-label=\"Hookline home\">HOOKLINE<span class=\"wordmark-mark\">/</span></a>\n      <span class=\"product-label\">HOOKS ANALYTICS DESK</span>\n      <nav class=\"main-nav\" aria-label=\"Primary navigation\">\n        <ul>\n          <li><a href=\"#/observatory\" data-view=\"observatory\">Observe</a></li>\n          <li><a href=\"#/watchlists\" data-view=\"watchlists\">Watchlists</a></li>\n          <li><a href=\"#/network\" data-view=\"network\">Network</a></li>\n        </ul>\n      </nav>\n      <div class=\"top-meta\">\n        <span id=\"top-live\" class=\"live-indicator loading\" role=\"status\" aria-live=\"polite\">PROBING</span>\n        <a class=\"social-link\" href=\"https://x.com/_hookline\" target=\"_blank\" rel=\"noopener noreferrer\" aria-label=\"Hookline on X\">X</a>\n        <a class=\"social-link\" href=\"https://flaunch.gg/base/coins/0x11672C8cD5CB3F17364339244826B110Bac0AC91\" target=\"_blank\" rel=\"noopener noreferrer\">HKLN</a>\n        <button id=\"top-copy-ca\" class=\"btn btn-ghost btn-compact\" type=\"button\">Copy CA</button>\n      </div>\n    </div>\n  </header>\n\n  <main id=\"main\" class=\"view-container\">\n    <section id=\"view-observatory\" class=\"view\" aria-labelledby=\"observe-title\">\n      <div class=\"desk-heading\">\n        <div>\n          <p class=\"eyebrow\">THE INTELLIGENCE LAYER FOR ONCHAIN HOOKS</p>\n          <h1 id=\"observe-title\">Observe the hook. Keep the evidence.</h1>\n          <p class=\"desk-lede\">Inspect, verify, monitor, and build around programmable liquidity across chains.</p>\n        </div>\n        <div class=\"desk-scope\" aria-label=\"Supported chains\">\n          <span>ETHEREUM</span><span>BASE</span><span>ARBITRUM</span><span>ROBINHOOD</span>\n        </div>\n      </div>\n\n      <div class=\"session-grid\" aria-label=\"Live desk summary\">\n        <div class=\"session-stat\"><span class=\"stat-label\">Chain health</span><strong id=\"observe-health\">unavailable</strong></div>\n        <div class=\"session-stat\"><span class=\"stat-label\">Base block</span><strong id=\"observe-base-block\">unavailable</strong></div>\n        <div class=\"session-stat\"><span class=\"stat-label\">Inspections this session</span><strong id=\"observe-session-count\">0</strong></div>\n        <div class=\"session-stat\"><span class=\"stat-label\">Saved observations</span><strong id=\"observe-saved-count\">0</strong></div>\n      </div>\n\n      <div class=\"observe-workbench\">\n        <form id=\"inspect-form\" class=\"inspect-form\" novalidate>\n          <div class=\"panel-kicker\">LIVE INSPECTOR</div>\n          <div class=\"form-row\">\n            <label for=\"inspect-chain\">Chain</label>\n            <select id=\"inspect-chain\" required>\n              <option value=\"1\">Ethereum (1)</option>\n              <option value=\"8453\" selected>Base (8453)</option>\n              <option value=\"42161\">Arbitrum One (42161)</option>\n              <option value=\"4663\">Robinhood Chain (4663)</option>\n            </select>\n          </div>\n          <div class=\"form-row\">\n            <label for=\"inspect-address\">Contract address</label>\n            <input id=\"inspect-address\" type=\"text\" inputmode=\"verbatim\" autocapitalize=\"off\" autocorrect=\"off\" autocomplete=\"off\" spellcheck=\"false\" value=\"0xb08211d57032dd10b1974d4b876851a7f7596888\" required>\n          </div>\n          <div class=\"form-row\">\n            <label for=\"inspect-label\">Label <span class=\"optional\">optional</span></label>\n            <input id=\"inspect-label\" type=\"text\" maxlength=\"80\" autocomplete=\"off\">\n          </div>\n          <div class=\"form-actions\">\n            <button id=\"inspect-btn\" class=\"btn btn-primary\" type=\"submit\">Inspect hook</button>\n            <button id=\"save-inspect-btn\" class=\"btn btn-secondary\" type=\"button\" disabled>Save to active list</button>\n          </div>\n          <p id=\"inspect-form-error\" class=\"form-error\" role=\"alert\" aria-live=\"assertive\"></p>\n          <p class=\"form-footnote\">Evidence is read directly from the selected chain through Hookline RPC.</p>\n        </form>\n\n        <section id=\"inspect-evidence\" class=\"evidence-panel\" aria-labelledby=\"evidence-heading\">\n          <div class=\"panel-kicker\">EVIDENCE OUTPUT</div>\n          <h2 id=\"evidence-heading\">Awaiting inspection</h2>\n          <p id=\"evidence-empty\" class=\"empty-copy\">Run an inspection to populate verified contract evidence.</p>\n          <div id=\"inspect-evidence-grid\" class=\"data-grid\" role=\"list\" aria-label=\"Inspection evidence\"></div>\n          <div id=\"inspect-permissions\" hidden>\n            <h3>Permission flags <span class=\"section-note\">low 14 address bits</span></h3>\n            <div id=\"inspect-perm-grid\" class=\"perm-grid\" role=\"group\" aria-label=\"Hook permission flags\"></div>\n          </div>\n          <p id=\"inspect-freshness\" class=\"note\" aria-live=\"polite\"></p>\n        </section>\n      </div>\n    </section>\n\n    <section id=\"view-watchlists\" class=\"view\" aria-labelledby=\"watchlists-heading\">\n      <div class=\"section-heading\">\n        <div>\n          <p class=\"eyebrow\">RESEARCH WORKSPACE</p>\n          <h1 id=\"watchlists-heading\">Watchlists</h1>\n        </div>\n        <p>Named local lists, live refreshes, evidence history, and same-chain comparisons.</p>\n      </div>\n\n      <div class=\"watchlists-layout\">\n        <aside class=\"lists-panel\" aria-label=\"Watchlist selection\">\n          <button id=\"new-list-btn\" class=\"btn btn-primary btn-compact\" type=\"button\">New list</button>\n          <ul id=\"lists-list\" role=\"list\" aria-label=\"Saved lists\"></ul>\n          <div id=\"lists-stats\" class=\"lists-stats\" role=\"status\" aria-live=\"polite\"></div>\n          <div class=\"lists-import\">\n            <input type=\"file\" id=\"import-file\" accept=\".json,application/json\" hidden>\n            <button id=\"export-btn\" class=\"btn btn-ghost btn-compact\" type=\"button\">Export JSON</button>\n            <button id=\"import-btn\" class=\"btn btn-ghost btn-compact\" type=\"button\">Import JSON</button>\n          </div>\n        </aside>\n\n        <div class=\"workspace-panel\">\n          <header class=\"workspace-toolbar\">\n            <div>\n              <span class=\"panel-kicker\">ACTIVE LIST</span>\n              <h2 id=\"active-list-name\" class=\"active-list-name\">Primary</h2>\n            </div>\n            <div class=\"toolbar-actions\">\n              <button id=\"refresh-list-btn\" class=\"btn btn-secondary btn-compact\" type=\"button\">Refresh list</button>\n              <progress id=\"refresh-progress\" max=\"1\" value=\"0\" hidden aria-label=\"Refresh progress\"></progress>\n              <input type=\"search\" id=\"watchlist-search\" class=\"search-input\" aria-label=\"Search active watchlist\">\n              <select id=\"watchlist-chain-filter\" aria-label=\"Filter by chain\">\n                <option value=\"all\">All chains</option>\n                <option value=\"1\">Ethereum</option>\n                <option value=\"8453\">Base</option>\n                <option value=\"42161\">Arbitrum</option>\n                <option value=\"4663\">Robinhood</option>\n              </select>\n              <select id=\"watchlist-state-filter\" aria-label=\"Filter by freshness state\">\n                <option value=\"all\">All states</option>\n                <option value=\"current\">Current</option>\n                <option value=\"stale\">Stale</option>\n                <option value=\"error\">Error</option>\n                <option value=\"unobserved\">Unobserved</option>\n              </select>\n              <button id=\"add-candidate-btn\" class=\"btn btn-primary btn-compact\" type=\"button\">Inspect new</button>\n            </div>\n          </header>\n\n          <div id=\"watchlist-empty\" class=\"empty-state\" hidden>\n            <strong>No contracts saved here.</strong>\n            <span>Inspect a live address, then save the evidence to this list.</span>\n          </div>\n          <div class=\"watchlist-table-container\">\n            <table id=\"watchlist-table\" class=\"watchlist-table\" aria-label=\"Watchlist contracts\">\n              <thead><tr><th>Chain</th><th>Contract</th><th>Observed</th><th>Block</th><th>Owner</th><th>Freshness</th><th>Action</th></tr></thead>\n              <tbody id=\"watchlist-tbody\"></tbody>\n            </table>\n          </div>\n\n          <section class=\"compare-section\" aria-labelledby=\"compare-heading\">\n            <div class=\"compare-heading-row\">\n              <div><span class=\"panel-kicker\">EVIDENCE DIFF</span><h2 id=\"compare-heading\">Compare two contracts</h2></div>\n              <p id=\"cmp-desc\">Same-chain comparisons only.</p>\n            </div>\n            <form id=\"compare-form\" class=\"compare-form\" novalidate>\n              <label>Left</label><select id=\"cmp-left\"><option value=\"\">Select a contract</option></select>\n              <label>Right</label><select id=\"cmp-right\"><option value=\"\">Select a contract</option></select>\n              <button class=\"btn btn-primary btn-compact\" type=\"submit\">Compare</button>\n            </form>\n            <div id=\"cmp-result\" class=\"compare-results\" role=\"status\" aria-live=\"polite\"></div>\n          </section>\n        </div>\n      </div>\n\n      <section id=\"watchlist-detail\" class=\"detail-drawer\" hidden aria-labelledby=\"detail-heading\">\n        <header class=\"detail-header\">\n          <div><span class=\"panel-kicker\">SAVED EVIDENCE</span><h2 id=\"detail-heading\"><span id=\"detail-label\"></span></h2></div>\n          <div class=\"detail-actions\">\n            <button id=\"refresh-candidate-btn\" class=\"btn btn-secondary btn-compact\" type=\"button\">Refresh</button>\n            <button id=\"remove-candidate-btn\" class=\"btn btn-ghost btn-compact\" type=\"button\">Remove</button>\n            <button id=\"close-detail-btn\" class=\"btn btn-ghost btn-compact\" type=\"button\">Close</button>\n          </div>\n        </header>\n        <div class=\"detail-body\">\n          <div id=\"detail-evidence\" class=\"data-grid\" role=\"list\" aria-label=\"Saved contract evidence\"></div>\n          <h3>Permission flags <span class=\"section-note\">low 14 address bits</span></h3>\n          <div id=\"detail-perm-grid\" class=\"perm-grid\" role=\"group\" aria-label=\"Permission flags\"></div>\n        </div>\n      </section>\n    </section>\n\n    <section id=\"view-network\" class=\"view\" aria-labelledby=\"network-heading\">\n      <div class=\"section-heading\">\n        <div><p class=\"eyebrow\">LIVE INFRASTRUCTURE</p><h1 id=\"network-heading\">Network and API</h1></div>\n        <p>Real upstream health, block height, latency, and two ways to call Hookline.</p>\n      </div>\n\n      <section class=\"telemetry-card card\" aria-labelledby=\"telemetry-heading\">\n        <div class=\"telemetry-header\">\n          <div><span class=\"panel-kicker\">MULTICHAIN TELEMETRY</span><h2 id=\"telemetry-heading\">Live network state</h2></div>\n          <button id=\"refresh-telemetry-btn\" class=\"btn btn-ghost btn-compact\" type=\"button\">Refresh</button>\n        </div>\n        <div id=\"telemetry-summary\" class=\"telemetry-summary\" role=\"status\" aria-live=\"polite\"></div>\n        <div class=\"table-scroll\">\n          <table id=\"chain-table\" class=\"data-table\" aria-label=\"Chain health table\">\n            <thead><tr><th>Chain</th><th>ID</th><th>Status</th><th>Latest block</th><th>Latency</th><th>Last error</th></tr></thead>\n            <tbody id=\"chain-table-body\"></tbody>\n          </table>\n        </div>\n      </section>\n\n      <div class=\"api-grid\">\n        <section class=\"card api-card\">\n          <span class=\"panel-kicker\">PUBLIC ACCESS</span>\n          <h2>Free RPC</h2>\n          <p>Hook inspection, permission decoding, chain status, and safe JSON-RPC methods. Rate limited to protect the service.</p>\n          <ul class=\"rpc-endpoints\">\n            <li><span>Hookline methods</span><code>POST /rpc</code><button class=\"btn btn-ghost btn-compact\" type=\"button\" data-copy=\"/rpc\">Copy</button></li>\n            <li><span>Chain proxy</span><code>POST /rpc/{chainId}</code><button class=\"btn btn-ghost btn-compact\" type=\"button\" data-copy=\"/rpc/{chainId}\">Copy</button></li>\n            <li><span>Docs</span><code>GET /rpc</code><button class=\"btn btn-ghost btn-compact\" type=\"button\" data-copy=\"/rpc\">Copy</button></li>\n          </ul>\n        </section>\n\n        <section class=\"card api-card paid-card\">\n          <span class=\"panel-kicker\">X402 CAPACITY</span>\n          <h2>Paid RPC</h2>\n          <p>Verified requests settle 0.01 USDC on Base to unlock the paid capacity path.</p>\n          <ul class=\"rpc-endpoints\">\n            <li><span>Endpoint</span><code>POST /rpc/paid</code><button class=\"btn btn-ghost btn-compact\" type=\"button\" data-copy=\"/rpc/paid\">Copy</button></li>\n            <li><span>Network</span><code>eip155:8453</code></li>\n            <li><span>Asset</span><code>USDC</code></li>\n            <li><span>Settlement</span><code class=\"breakable\">0x69e73F4B54ED92939D48B5472894179BF3292DD3</code></li>\n          </ul>\n        </section>\n      </div>\n    </section>\n  </main>\n\n  <section class=\"token-strip\" aria-label=\"HKLN service information\">\n    <div class=\"token-inner\">\n      <div class=\"token-intro\"><span class=\"panel-kicker\">SERVICE LAYER</span><strong>HKLN on Base</strong><p>Public service access, paid capacity infrastructure, and ecosystem alignment.</p></div>\n      <div class=\"token-col\"><span>Contract</span><code class=\"breakable\">0x11672C8cD5CB3F17364339244826B110Bac0AC91</code><button id=\"strip-copy-ca\" class=\"btn btn-ghost btn-compact\" type=\"button\">Copy CA</button></div>\n      <div class=\"token-col\"><span>Capacity wallet</span><code class=\"breakable\">0x69e73F4B54ED92939D48B5472894179BF3292DD3</code><button id=\"strip-copy-fee\" class=\"btn btn-ghost btn-compact\" type=\"button\">Copy wallet</button></div>\n      <div class=\"token-links\"><a href=\"https://basescan.org/token/0x11672C8cD5CB3F17364339244826B110Bac0AC91\" target=\"_blank\" rel=\"noopener noreferrer\">BaseScan</a><a href=\"https://flaunch.gg/base/coins/0x11672C8cD5CB3F17364339244826B110Bac0AC91\" target=\"_blank\" rel=\"noopener noreferrer\">Flaunch</a><a href=\"https://x.com/_hookline\" target=\"_blank\" rel=\"noopener noreferrer\">X</a></div>\n    </div>\n  </section>\n\n  <footer class=\"site-footer\">\n    <span>HOOKLINE / MULTICHAIN HOOKS ANALYTICS DESK</span>\n    <span>Ethereum · Base · Arbitrum · Robinhood Chain</span>\n    <a href=\"#/network\">RPC and network</a>\n    <p>\n      <code>0x11672C8cD5CB3F17364339244826B110Bac0AC91</code> ·\n      <code>0x69e73F4B54ED92939D48B5472894179BF3292DD3</code> ·\n      <a href=\"https://x.com/_hookline\" target=\"_blank\" rel=\"noopener noreferrer\">X</a> ·\n      <a href=\"https://flaunch.gg/base/coins/0x11672C8cD5CB3F17364339244826B110Bac0AC91\" target=\"_blank\" rel=\"noopener noreferrer\">Flaunch</a>\n    </p>\n  </footer>\n\n  <div id=\"hookline-toast\" class=\"toast\" role=\"status\" aria-live=\"polite\" aria-atomic=\"true\"></div>\n  <script src=\"app.js\"></script>\n</body>\n</html>\n",
  css: "/* =========================================\n   Hookline — multichain hook observation console\n   Plain CSS, no framework. Obsidian-black + bone-white,\n   acid-lime primary signal, cyan secondary signal.\n   ========================================= */\n\n:root {\n  --obsidian:  #0b0e12;\n  --obsidian-2:#11161f;\n  --obsidian-3:#1a212b;\n  --bone:      #f4f1ea;\n  --bone-dim:  #bfb8a8;\n  --bone-mute: #8a8373;\n  --lime:      #c8f73c;\n  --lime-dim:  #97c31f;\n  --cyan:      #63f0f9;\n  --cyan-dim:  #3a9aa1;\n  --grid:      #2b3440;\n  --grid-dim:  #232a33;\n  --red:       #f46060;\n  --amber:     #f0b05c;\n  --green:     #4caf8e;\n  --ink:       #0b0e12;\n  --focus:     #c8f73c;\n\n  --font-sans: system-ui, -apple-system, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n  --font-mono: ui-monospace, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace;\n\n  --border: 1px solid var(--grid);\n  --border-strong: 1px solid var(--grid-dim);\n\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;\n  --space-5: 24px;\n  --space-6: 32px;\n}\n\n/* ---- base ---- */\n*, *::before, *::after { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nhtml { font-size: 16px; -webkit-font-smoothing: antialiased; }\nbody {\n  margin: 0;\n  background: var(--obsidian);\n  color: var(--bone);\n  font-family: var(--font-sans);\n  line-height: 1.5;\n  min-height: 100vh;\n  display: flex;\n  flex-direction: column;\n}\n\ncode, kbd, pre, .mono {\n  font-family: var(--font-mono);\n  font-size: 0.875em;\n}\n\na { color: var(--cyan); text-decoration: none; }\na:hover { text-decoration: underline; }\na:focus-visible {\n  outline: 2px solid var(--focus);\n  outline-offset: 2px;\n}\n\nbutton {\n  font-family: inherit;\n  font-size: inherit;\n}\nbutton, input, select { border-radius: 0; }\nbutton:focus-visible,\ninput:focus-visible,\nselect:focus-visible {\n  outline: 2px solid var(--focus);\n  outline-offset: 2px;\n}\n\n.skip-link {\n  position: absolute;\n  left: -9999px;\n  top: 0;\n  background: var(--lime);\n  color: var(--obsidian);\n  padding: var(--space-2) var(--space-3);\n  font-weight: 600;\n  z-index: 9999;\n}\n.skip-link:focus { left: var(--space-2); top: var(--space-2); }\n\n.visually-hidden {\n  position: absolute;\n  width: 1px; height: 1px;\n  padding: 0; margin: -1px;\n  overflow: hidden;\n  clip: rect(0, 0, 0, 0);\n  white-space: nowrap;\n  border: 0;\n}\n\n/* ---- top bar ---- */\n.top-bar {\n  border-bottom: var(--border-strong);\n  background: var(--obsidian-2);\n  position: sticky;\n  top: 0;\n  z-index: 20;\n}\n.top-inner {\n  max-width: 1400px;\n  margin: 0 auto;\n  padding: var(--space-2) var(--space-4);\n  display: flex;\n  align-items: center;\n  gap: var(--space-4);\n}\n.wordmark {\n  font-size: 1.125rem;\n  font-weight: 700;\n  letter-spacing: 0.06em;\n  color: var(--lime);\n  text-transform: uppercase;\n}\n.wordmark-mark { color: var(--cyan); }\n.product-label {\n  color: var(--bone-mute);\n  font-family: var(--font-mono);\n  font-size: 0.688rem;\n  letter-spacing: 0.08em;\n  white-space: nowrap;\n}\n.main-nav ul {\n  list-style: none;\n  margin: 0;\n  padding: 0;\n  display: flex;\n  gap: var(--space-1);\n  flex-wrap: wrap;\n}\n.main-nav a {\n  display: inline-block;\n  padding: var(--space-1) var(--space-3);\n  color: var(--bone);\n  border: var(--border);\n  border-radius: 0;\n  font-size: 0.75rem;\n  text-transform: uppercase;\n  letter-spacing: 0.06em;\n}\n.main-nav a.active,\n.main-nav a:hover {\n  background: var(--obsidian-3);\n  color: var(--lime);\n  text-decoration: none;\n}\n.main-nav a.active { border-color: var(--lime); }\n\n.top-meta {\n  margin-left: auto;\n  display: flex;\n  align-items: center;\n  gap: var(--space-2);\n  font-size: 0.75rem;\n}\n.live-indicator {\n  padding: var(--space-1) var(--space-2);\n  border: 1px solid var(--lime);\n  color: var(--lime);\n  font-family: var(--font-mono);\n  text-transform: uppercase;\n  letter-spacing: 0.06em;\n}\n.live-indicator.live { border-color: var(--lime); color: var(--lime); }\n.live-indicator.offline { border-color: var(--red); color: var(--red); }\n.live-indicator.loading { border-color: var(--amber); color: var(--amber); }\n.social-link {\n  padding: var(--space-1) var(--space-2);\n  border: var(--border);\n  color: var(--bone-dim);\n  font-size: 0.75rem;\n  text-transform: uppercase;\n  letter-spacing: 0.06em;\n}\n\n/* ---- main / views ---- */\n.view-container {\n  max-width: 1400px;\n  margin: 0 auto;\n  flex: 1;\n  padding: var(--space-5) var(--space-5);\n  width: 100%;\n}\n.view { display: none; }\n.view.active { display: block; }\n\n/* ---- buttons ---- */\n.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: var(--space-2);\n  padding: var(--space-2) var(--space-4);\n  border: var(--border);\n  background: var(--obsidian-3);\n  color: var(--bone);\n  cursor: pointer;\n  border-radius: 0;\n  font-size: 0.875rem;\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n  transition: background 0.15s, border-color 0.15s;\n}\n.btn:hover { background: var(--obsidian); border-color: var(--bone-dim); }\n.btn:disabled { opacity: 0.45; cursor: not-allowed; }\n.btn-compact { padding: var(--space-1) var(--space-3); font-size: 0.75rem; }\n.btn-primary {\n  border-color: var(--lime);\n  color: var(--obsidian);\n  background: var(--lime);\n  font-weight: 700;\n}\n.btn-primary:hover:not(:disabled) {\n  background: transparent;\n  border-color: var(--lime);\n  color: var(--lime);\n}\n.btn-secondary { border-color: var(--cyan); color: var(--cyan); }\n.btn-secondary:hover:not(:disabled) { background: var(--obsidian); border-color: var(--cyan); color: var(--cyan); }\n.btn-ghost {\n  background: transparent;\n  border-color: var(--grid-dim);\n  color: var(--bone-dim);\n}\n.btn-ghost:hover:not(:disabled) { background: var(--obsidian-3); color: var(--bone); }\n.btn-copy { padding: var(--space-1) var(--space-2); font-size: 0.75rem; }\n.btn-copy.copied { border-color: var(--lime); color: var(--lime); }\n\n/* ---- forms ---- */\n.form-row {\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-1);\n  margin-bottom: var(--space-3);\n}\n.form-row > label {\n  font-size: 0.813rem;\n  color: var(--bone-dim);\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n}\n.form-row input,\n.form-row select {\n  appearance: none;\n  background: var(--obsidian-3);\n  border: var(--border);\n  color: var(--bone);\n  padding: var(--space-2);\n  font-family: var(--font-mono);\n  font-size: 0.875rem;\n  border-radius: 0;\n  width: 100%;\n}\n.form-row input:focus,\n.form-row select:focus {\n  outline: none;\n  border-color: var(--lime);\n  box-shadow: 0 0 0 2px color-mix(in srgb, var(--lime), transparent 70%);\n}\n\n.form-row .hint {\n  font-size: 0.75rem;\n  color: var(--bone-mute);\n  margin: 0;\n}\n.form-error {\n  margin: 0;\n  font-size: 0.813rem;\n  color: var(--red);\n  min-height: 1.2em;\n}\n.form-actions { display: flex; gap: var(--space-2); align-items: flex-start; flex-wrap: wrap; }\n.form-actions .form-error { flex: 1 1 100%; }\n\nselect,\n.compare-form select,\n.toolbar-actions select {\n  appearance: none;\n  background: var(--obsidian-3);\n  border: var(--border);\n  color: var(--bone);\n  font-family: var(--font-mono);\n  font-size: 0.75rem;\n  padding: 7px 28px 7px 9px;\n  background-image: none;\n}\n\nh1 {\n  margin: 0;\n  max-width: 820px;\n  font-size: clamp(2rem, 4vw, 4.7rem);\n  line-height: 0.98;\n  letter-spacing: -0.055em;\n}\n.eyebrow,\n.panel-kicker {\n  margin: 0 0 var(--space-2);\n  color: var(--lime);\n  font-family: var(--font-mono);\n  font-size: 0.688rem;\n  font-weight: 700;\n  letter-spacing: 0.1em;\n}\n.panel-kicker { color: var(--cyan); }\n.optional,\n.section-note {\n  color: var(--bone-mute);\n  font-size: 0.688rem;\n  font-weight: 400;\n  letter-spacing: 0;\n  text-transform: none;\n}\n.desk-heading,\n.section-heading {\n  display: flex;\n  justify-content: space-between;\n  gap: var(--space-6);\n  align-items: end;\n  margin-bottom: var(--space-5);\n  padding-bottom: var(--space-5);\n  border-bottom: var(--border);\n}\n.desk-lede,\n.section-heading > p {\n  max-width: 680px;\n  margin: var(--space-3) 0 0;\n  color: var(--bone-dim);\n  font-size: 0.938rem;\n}\n.section-heading h1 { font-size: clamp(2rem, 3vw, 3.4rem); }\n.section-heading > p { max-width: 430px; margin: 0; }\n.desk-scope {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: var(--space-1);\n  min-width: 250px;\n}\n.desk-scope span {\n  border: var(--border);\n  padding: var(--space-2);\n  color: var(--bone-dim);\n  font-family: var(--font-mono);\n  font-size: 0.688rem;\n  text-align: center;\n}\n.session-grid {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n  margin-bottom: var(--space-4);\n  border-top: var(--border);\n  border-left: var(--border);\n}\n.session-stat {\n  min-width: 0;\n  padding: var(--space-3);\n  border-right: var(--border);\n  border-bottom: var(--border);\n  background: var(--obsidian-2);\n}\n.session-stat .stat-label {\n  display: block;\n  margin-bottom: var(--space-1);\n  color: var(--bone-mute);\n  font-family: var(--font-mono);\n  font-size: 0.688rem;\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n}\n.session-stat strong {\n  display: block;\n  overflow: hidden;\n  color: var(--bone);\n  font-family: var(--font-mono);\n  font-size: 1.1rem;\n  text-overflow: ellipsis;\n}\n.observe-workbench {\n  display: grid;\n  grid-template-columns: minmax(300px, 0.75fr) minmax(0, 1.25fr);\n  gap: var(--space-4);\n  align-items: start;\n}\n.form-footnote,\n.empty-copy {\n  margin: var(--space-4) 0 0;\n  color: var(--bone-mute);\n  font-size: 0.75rem;\n}\n.inspect-form,\n.evidence-panel {\n  min-height: 435px;\n  margin: 0;\n}\n.evidence-panel h2 {\n  margin-bottom: var(--space-4);\n  font-family: var(--font-mono);\n  font-size: 1.15rem;\n}\n.evidence-panel h3,\n.detail-body h3 { margin-top: var(--space-5); }\n\n/* ---- inspector ---- */\n.inspect-form {\n  background: var(--obsidian-2);\n  border: var(--border);\n  padding: var(--space-4);\n  margin-bottom: var(--space-5);\n}\n.evidence-panel { background: var(--obsidian-2); border: var(--border); padding: var(--space-4); }\n.data-grid {\n  display: grid;\n  grid-template-columns: 1fr 3fr;\n  gap: var(--space-2);\n}\n.label {\n  font-size: 0.813rem;\n  color: var(--bone-dim);\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n  line-height: 1.5;\n}\n.value { font-family: var(--font-mono); font-size: 0.875rem; color: var(--bone); }\n.value.mono { word-break: break-all; }\n\n/* ---- inspector: permissions & notes ---- */\n.perm-note {\n  font-size: 0.75rem;\n  color: var(--bone-mute);\n  margin: 0 0 var(--space-2);\n}\n.perm-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));\n  gap: var(--space-2);\n  margin-bottom: var(--space-4);\n}\n.flag {\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-1);\n  padding: var(--space-2);\n  background: var(--obsidian-3);\n  border: var(--border);\n  font-size: 0.75rem;\n}\n.flag[aria-pressed=\"true\"] {\n  border-color: var(--lime);\n  background: color-mix(in srgb, var(--lime), transparent 95%);\n}\n.flag-name {\n  font-family: var(--font-mono);\n  text-transform: lowercase;\n}\n.flag-val {\n  font-size: 0.688rem;\n  color: var(--lime-dim);\n  text-transform: uppercase;\n}\n.flag[aria-pressed=\"true\"] .flag-val { color: var(--lime); }\n\n/* ---- common components ---- */\nh2 { margin: 0 0 var(--space-4); font-size: 1.25rem; letter-spacing: 0.03em; border-bottom: var(--border); padding-bottom: var(--space-2); }\nh3 { margin: 0 0 var(--space-2); font-size: 1rem; }\np { margin: 0 0 var(--space-3); }\n.note { margin: 0; font-size: 0.813rem; color: var(--bone-mute); }\n.card { background: var(--obsidian-2); border: var(--border); padding: var(--space-4); margin-bottom: var(--space-5); }\n.card :last-child { margin-bottom: 0; }\n.empty-state {\n  background: var(--obsidian-2);\n  border: var(--border);\n  padding: var(--space-6);\n  text-align: center;\n  color: var(--bone-dim);\n  font-size: 0.938rem;\n}\n.table-scroll { overflow-x: auto; }\n.data-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 0.875rem;\n}\n.data-table th,\n.data-table td {\n  border: var(--border);\n  padding: var(--space-2) var(--space-3);\n  text-align: left;\n}\n.data-table th {\n  background: var(--obsidian-3);\n  color: var(--bone-dim);\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n  font-size: 0.75rem;\n}\n.data-table td strong { color: var(--bone); }\n\n/* ---- status chips (never color-only) ---- */\n.status-chip {\n  display: inline-flex;\n  align-items: center;\n  gap: var(--space-1);\n  padding: var(--space-1) var(--space-2);\n  font-size: 0.688rem;\n  font-weight: 700;\n  text-transform: uppercase;\n  letter-spacing: 0.06em;\n  border: 1px solid;\n  white-space: nowrap;\n}\n.status-chip.current { border-color: var(--lime); color: var(--lime); }\n.status-chip.stale { border-color: var(--amber); color: var(--amber); }\n.status-chip.error { border-color: var(--red); color: var(--red); }\n.status-chip.unobserved { border-color: var(--grid-dim); color: var(--bone-dim); }\n.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: var(--space-1); }\n.status-chip.current .status-dot { background: var(--lime); }\n.status-chip.stale .status-dot { background: var(--amber); }\n.status-chip.error .status-dot { background: var(--red); }\n\n/* ---- watchlists ---- */\n.watchlists-layout {\n  display: grid;\n  grid-template-columns: 270px 1fr;\n  gap: var(--space-5);\n}\n.lists-panel {\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-3);\n  height: calc(100vh - 200px);\n  overflow-y: auto;\n}\n.lists-controls { background: var(--obsidian-2); border: var(--border); padding: var(--space-3); }\n.lists-import { background: var(--obsidian-2); border: var(--border); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }\n.lists-stats { font-size: 0.813rem; color: var(--bone-dim); }\n.lists-stats strong { color: var(--bone); }\n#lists-list {\n  list-style: none;\n  margin: 0;\n  padding: 0;\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-1);\n}\n.list-item {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--space-2);\n  padding: 0;\n  background: var(--obsidian-3);\n  border: var(--border);\n  border-radius: 0;\n  font-size: 0.875rem;\n  transition: background 0.15s, border-color 0.15s;\n}\n.list-item:hover { border-color: var(--bone-dim); }\n.list-item.active { border-color: var(--lime); background: color-mix(in srgb, var(--lime), transparent 94%); }\n.list-item.active .list-name { color: var(--lime); }\n.list-item.active .list-count { color: var(--lime); }\n.list-select {\n  display: flex;\n  flex: 1 1 auto;\n  align-items: center;\n  justify-content: space-between;\n  min-width: 0;\n  padding: var(--space-2);\n  border: 0;\n  background: transparent;\n  color: inherit;\n  cursor: pointer;\n  text-align: left;\n}\n.list-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.list-count { font-size: 0.75rem; color: var(--bone-mute); font-family: var(--font-mono); }\n.list-item-menu {\n  display: flex;\n  gap: var(--space-1);\n  padding-right: var(--space-1);\n}\n.list-mini-action {\n  padding: 3px 5px;\n  border: 0;\n  background: transparent;\n  color: var(--bone-mute);\n  cursor: pointer;\n  font-size: 0.625rem;\n  text-transform: uppercase;\n}\n.list-mini-action:hover:not(:disabled) { color: var(--cyan); }\n.list-mini-action:disabled { opacity: 0.3; cursor: not-allowed; }\n\n.workspace-panel { min-width: 0; }\n.workspace-toolbar {\n  display: flex;\n  flex-wrap: wrap;\n  gap: var(--space-3);\n  align-items: center;\n  margin-bottom: var(--space-3);\n  padding-bottom: var(--space-3);\n  border-bottom: var(--border);\n}\n.workspace-toolbar > div:first-child { min-width: 150px; }\n.active-list-name { flex: 1 1 auto; margin: 0; font-size: 1.125rem; }\n.toolbar-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: var(--space-2);\n  align-items: center;\n}\n.search-input {\n  background: var(--obsidian-3);\n  border: var(--border);\n  color: var(--bone);\n  padding: var(--space-1) var(--space-3);\n  font-family: var(--font-mono);\n  font-size: 0.813rem;\n  border-radius: 0;\n  min-width: 180px;\n}\n.search-input:focus { outline: none; border-color: var(--lime); box-shadow: 0 0 0 2px color-mix(in srgb, var(--lime), transparent 70%); }\nprogress {\n  appearance: none;\n  width: 120px;\n  height: 6px;\n  background: var(--obsidian-3);\n  border: var(--border);\n  border-radius: 0;\n}\nprogress::-webkit-progress-bar { background: var(--obsidian-3); }\nprogress::-webkit-progress-value { background: var(--cyan); }\nprogress::-moz-progress-bar { background: var(--cyan); }\n\n/* ---- watchlist table ---- */\n.watchlist-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 0.875rem;\n}\n.watchlist-table th {\n  background: var(--obsidian-3);\n  color: var(--bone-dim);\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n  font-size: 0.75rem;\n  padding: var(--space-2) var(--space-3);\n  border: var(--border);\n  text-align: left;\n}\n.watchlist-table td {\n  padding: var(--space-2) var(--space-3);\n  border: var(--border);\n  font-size: 0.875rem;\n}\n.watchlist-table tbody tr { cursor: pointer; }\n.watchlist-table tbody tr:hover { background: var(--obsidian-3); }\n.watchlist-table tbody tr.selected { background: color-mix(in srgb, var(--lime), transparent 94%); }\n.watchlist-table .chain-chip { font-size: 0.688rem; padding: 2px 6px; background: var(--obsidian-3); border: var(--border); text-transform: uppercase; letter-spacing: 0.05em; color: var(--bone-dim); }\n.watchlist-table .address { font-family: var(--font-mono); font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }\n.contract-label { display: block; margin-bottom: 2px; font-size: 0.813rem; }\n.watchlist-table .owner { font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; color: var(--bone-mute); }\n.watchlist-table .actions { display: flex; gap: var(--space-1); }\n.watchlist-table .btn-sm { padding: 2px 6px; font-size: 0.688rem; }\n.status-chip.unobserved .status-dot { background: var(--bone-dim); }\n\n/* ---- compare ---- */\n.compare-section { margin-top: var(--space-5); padding-top: var(--space-5); border-top: var(--border); }\n.compare-heading-row { display: flex; align-items: end; justify-content: space-between; gap: var(--space-4); }\n.compare-heading-row p { margin: 0 0 var(--space-2); color: var(--bone-mute); font-size: 0.75rem; }\n.compare-section h3 { font-size: 1rem; }\n.compare-form {\n  display: grid;\n  grid-template-columns: 1fr 1fr auto;\n  gap: var(--space-3);\n  align-items: end;\n  margin-bottom: var(--space-3);\n  background: var(--obsidian-2);\n  border: var(--border);\n  padding: var(--space-3);\n}\n.compare-form label {\n  display: grid;\n  gap: var(--space-1);\n  color: var(--bone-dim);\n  font-size: 0.688rem;\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n}\n.comp-select { display: flex; flex-direction: column; gap: var(--space-1); }\n.comp-select label { font-size: 0.813rem; color: var(--bone-dim); text-transform: uppercase; letter-spacing: 0.05em; }\n.compare-results { background: var(--obsidian-2); border: var(--border); padding: var(--space-4); }\n.comp-refusal { background: color-mix(in srgb, var(--red), transparent 94%); border: 1px solid var(--red); padding: var(--space-3); color: var(--bone); }\n.comp-refusal .refusal-title { color: var(--red); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.875rem; margin: 0 0 var(--space-2); }\n.comp-refusal .hint { font-size: 0.75rem; color: var(--bone-dim); }\n.comp-refusal strong { color: var(--bone); }\n.comp-ok .comp-row { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-2); }\n.comp-ok .comp-row .label { color: var(--bone-dim); text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.813rem; min-width: 160px; }\n.comp-ok .comp-row code { font-family: var(--font-mono); }\n.comp-ok .ok { color: var(--lime); font-weight: 700; }\n.comp-ok .bad { color: var(--red); font-weight: 700; }\n.perm-delta { display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: var(--space-2); margin-bottom: var(--space-3); }\n.perm-delta .row { display: contents; }\n.perm-delta .cell { background: var(--obsidian-3); border: var(--border); padding: var(--space-2); font-size: 0.75rem; }\n[class~=\"a\"], [class~=\"b\"] { text-align: center; }\n[class~=\"same\"] { color: var(--bone-dim); text-align: center; }\n[class~=\"diff\"] { color: var(--red); text-align: center; }\n[class~=\"enabled\"] { color: var(--lime); }\n.perm-delta .row-header { font-weight: 700; text-transform: uppercase; font-size: 0.688rem; letter-spacing: 0.05em; }\n.perm-delta .row-header.a { color: var(--cyan); }\n.perm-delta .row-header.b { color: var(--amber); }\n.perm-delta .row-header.d { color: var(--bone-mute); text-align: center; }\n.perm-delta .row-flag .flag-name { text-transform: lowercase; }\n.cmp-result-row { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-2); }\n.cmp-result-row .label { color: var(--bone-dim); text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.813rem; min-width: 170px; }\n.cmp-result-row code { font-family: var(--font-mono); font-size: 0.813rem; }\n\n/* ---- detail drawer ---- */\n.detail-drawer {\n  background: var(--obsidian-2);\n  border: var(--border);\n  margin-top: var(--space-5);\n  display: block;\n}\n.detail-header { padding: var(--space-3) var(--space-4); border-bottom: var(--border); display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }\n.detail-header h3 { margin: 0; }\n.detail-body { padding: var(--space-4); }\n.detail-actions { display: flex; gap: var(--space-2); }\n\n/* ---- network / telemetry ---- */\n.telemetry-card { margin-bottom: var(--space-5); }\n.telemetry-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }\n.telemetry-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-4); }\n.telemetry-summary .stat { background: var(--obsidian-3); border: var(--border); padding: var(--space-3); text-align: center; }\n.telemetry-summary .stat-label { font-size: 0.75rem; color: var(--bone-dim); text-transform: uppercase; letter-spacing: 0.05em; }\n.telemetry-summary .stat-value { font-size: 1.25rem; font-weight: 700; color: var(--bone); font-family: var(--font-mono); }\n.rpc-row { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); margin-bottom: var(--space-4); }\n.rpc-lede { margin: 0; color: var(--bone-dim); }\n.rpc-endpoints { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }\n.rpc-endpoints li { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2); background: var(--obsidian-3); border: var(--border); }\n.rpc-label { font-size: 0.75rem; color: var(--bone-dim); text-transform: uppercase; letter-spacing: 0.05em; min-width: 90px; }\n.rpc-code { font-family: var(--font-mono); font-size: 0.813rem; color: var(--cyan); }\n.api-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }\n.api-card { margin: 0; }\n.api-card h2,\n.telemetry-header h2 { margin: 0 0 var(--space-2); border: 0; padding: 0; }\n.api-card > p { color: var(--bone-dim); min-height: 3em; }\n.paid-card { border-color: var(--cyan-dim); }\n.rpc-endpoints li > span:first-child { min-width: 105px; color: var(--bone-mute); font-size: 0.688rem; text-transform: uppercase; }\n.rpc-endpoints li code { min-width: 0; overflow: hidden; text-overflow: ellipsis; }\n.rpc-endpoints li button { margin-left: auto; }\n.breakable { overflow-wrap: anywhere; }\n\n/* ---- token strip ---- */\n.token-strip {\n  border-top: var(--border);\n  background: var(--obsidian-2);\n  padding: var(--space-3) var(--space-5);\n  font-size: 0.813rem;\n}\n.token-inner {\n  max-width: 1400px;\n  margin: 0 auto;\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  gap: var(--space-4);\n}\n.token-intro { grid-column: span 1; }\n.token-intro strong { display: block; margin-bottom: var(--space-1); }\n.token-intro p { color: var(--bone-dim); font-size: 0.75rem; }\n.token-col { display: flex; flex-direction: column; gap: var(--space-1); }\n.token-col > span { color: var(--bone-mute); font-size: 0.688rem; letter-spacing: 0.06em; text-transform: uppercase; }\n.token-label { font-size: 0.688rem; color: var(--bone-mute); text-transform: uppercase; letter-spacing: 0.06em; }\n.token-col code { font-size: 0.813rem; color: var(--bone-dim); font-family: var(--font-mono); }\n.token-col code a { color: var(--cyan); }\n.token-text { color: var(--bone-dim); font-size: 0.813rem; }\n.token-link { color: var(--bone-dim); font-size: 0.813rem; }\n.token-link:hover { color: var(--bone); }\n.token-links { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); }\n.token-links a { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }\n\n.site-footer {\n  display: flex;\n  justify-content: space-between;\n  gap: var(--space-4);\n  padding: var(--space-3) var(--space-5);\n  border-top: var(--border);\n  color: var(--bone-mute);\n  font-family: var(--font-mono);\n  font-size: 0.688rem;\n}\n.toast {\n  position: fixed;\n  right: var(--space-4);\n  bottom: var(--space-4);\n  z-index: 50;\n  max-width: min(430px, calc(100vw - 32px));\n  padding: var(--space-3) var(--space-4);\n  border: 1px solid var(--cyan);\n  background: var(--obsidian-2);\n  color: var(--bone);\n  opacity: 0;\n  pointer-events: none;\n  transform: translateY(8px);\n  transition: opacity 0.15s, transform 0.15s;\n  font-size: 0.813rem;\n}\n.toast.show { opacity: 1; transform: translateY(0); }\n.toast.alert { border-color: var(--red); }\n.btn.copied { border-color: var(--lime); color: var(--lime); }\n.empty-state { display: flex; flex-direction: column; gap: var(--space-1); }\n.empty-state strong { color: var(--bone); }\n\n/* ---- mobile (< 760px) ---- */\n@media (max-width: 760px) {\n  .top-inner { flex-direction: column; align-items: flex-start; gap: var(--space-3); }\n  .top-meta { margin-left: 0; flex-wrap: wrap; }\n  .wordmark { width: 100%; }\n  .product-label { display: none; }\n  .main-nav a { font-size: 0.688rem; padding: var(--space-1) var(--space-2); }\n  .view-container { padding: var(--space-4); }\n  .desk-heading, .section-heading { display: block; }\n  .desk-scope { margin-top: var(--space-4); min-width: 0; }\n  .section-heading > p { margin-top: var(--space-3); }\n  .session-grid { grid-template-columns: 1fr 1fr; }\n  .observe-workbench, .api-grid { grid-template-columns: 1fr; }\n  .inspect-form, .evidence-panel { min-height: 0; }\n  .watchlists-layout { grid-template-columns: 1fr; }\n  .lists-panel { height: auto; }\n  .lists-controls, .lists-import { display: flex; flex-direction: row; flex-wrap: wrap; }\n  .lists-panel > * { margin-bottom: var(--space-2); }\n  .workspace-toolbar { flex-direction: column; align-items: stretch; }\n  .toolbar-actions { flex-wrap: wrap; }\n  .search-input { min-width: 100%; }\n  .compare-form { grid-template-columns: 1fr; }\n  .detail-header { flex-wrap: wrap; }\n  .detail-actions { flex-wrap: wrap; }\n  .token-inner { grid-template-columns: 1fr 1fr; }\n  .token-strip { padding: var(--space-3); }\n  .site-footer { flex-direction: column; padding: var(--space-3); }\n  .watchlist-table-container { overflow-x: auto; }\n  .watchlist-table { min-width: 830px; }\n  .data-grid { grid-template-columns: 1fr; }\n  .data-grid .label { margin-top: var(--space-2); }\n}\n\n@media (max-width: 460px) {\n  .session-grid, .token-inner { grid-template-columns: 1fr; }\n  .toolbar-actions > * { width: 100%; }\n  .main-nav ul { gap: 0; }\n  .rpc-endpoints li { align-items: flex-start; flex-wrap: wrap; }\n}\n\n/* ---- reduced motion ---- */\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }\n}\n.social-link:hover { color: var(--bone); border-color: var(--bone-dim); }\n",
  app: "/** Hookline multichain hooks analytics desk. Vanilla browser runtime. */\n(function () {\n  'use strict';\n\n  const CHAINS = Object.freeze({\n    1: { name: 'Ethereum', code: 'ETH' },\n    8453: { name: 'Base', code: 'BASE' },\n    42161: { name: 'Arbitrum One', code: 'ARB' },\n    4663: { name: 'Robinhood Chain', code: 'RHB' },\n  });\n  const SUPPORTED_CHAINS = Object.freeze([1, 8453, 42161, 4663]);\n  const PERMISSION_FLAGS = Object.freeze([\n    'beforeInitialize', 'afterInitialize', 'beforeAddLiquidity', 'afterAddLiquidity',\n    'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeSwap', 'afterSwap',\n    'beforeDonate', 'afterDonate', 'beforeSwapReturnDelta', 'afterSwapReturnDelta',\n    'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta',\n  ]);\n  const TOKEN_CA = '0x11672C8cD5CB3F17364339244826B110Bac0AC91';\n  const FEE_WALLET = '0x69e73F4B54ED92939D48B5472894179BF3292DD3';\n  const WATCHLISTS_KEY = 'hookline:watchlists:v3';\n  const WATCHLISTS_V2_KEY = 'hookline:watchlist:v2';\n  const MAX_LISTS = 20;\n  const MAX_ITEMS_PER_LIST = 100;\n  const MAX_OBSERVATIONS = 100;\n  const MAX_IMPORT_BYTES = 1024 * 1024;\n  const CURRENT_WINDOW_MS = 15 * 60 * 1000;\n  const VIEWS = new Set(['observatory', 'watchlists', 'network']);\n\n  const $ = (id) => document.getElementById(id);\n  const $$ = (selector) => Array.from(document.querySelectorAll(selector));\n  const state = {\n    model: null,\n    selectedId: null,\n    inspected: null,\n    inspectionsThisSession: 0,\n    metrics: null,\n    healthOk: null,\n    toastTimer: null,\n    refreshing: false,\n  };\n\n  function makeId(prefix) {\n    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {\n      return prefix + '-' + globalThis.crypto.randomUUID();\n    }\n    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);\n  }\n\n  function cleanString(value, maxLength) {\n    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';\n  }\n\n  function makeElement(tag, className, text) {\n    const node = document.createElement(tag);\n    if (className) node.className = className;\n    if (text != null) node.textContent = String(text);\n    return node;\n  }\n\n  function formatNumber(value) {\n    return Number.isFinite(value) ? value.toLocaleString() : 'unavailable';\n  }\n\n  function formatLatency(value) {\n    return Number.isFinite(value) ? Math.round(value).toLocaleString() + ' ms' : 'unavailable';\n  }\n\n  function formatDate(value) {\n    const date = new Date(value);\n    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'unavailable';\n  }\n\n  function relativeTime(value) {\n    const timestamp = Number(value);\n    if (!Number.isFinite(timestamp)) return 'never';\n    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));\n    if (seconds < 10) return 'just now';\n    if (seconds < 60) return seconds + 's ago';\n    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';\n    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';\n    return Math.round(seconds / 86400) + 'd ago';\n  }\n\n  function shorten(value, head, tail) {\n    const text = String(value || '');\n    const first = head || 7;\n    const last = tail || 5;\n    return text.length > first + last ? text.slice(0, first) + '…' + text.slice(-last) : text;\n  }\n\n  function validateAddress(raw) {\n    const address = String(raw || '').trim().toLowerCase();\n    return /^0x[0-9a-f]{40}$/.test(address)\n      ? { ok: true, address }\n      : { ok: false, message: 'Enter a 0x-prefixed address with exactly 40 hexadecimal characters.' };\n  }\n\n  function validateChainId(raw) {\n    const chainId = Number(raw);\n    return Number.isInteger(chainId) && SUPPORTED_CHAINS.includes(chainId)\n      ? { ok: true, chainId }\n      : { ok: false, message: 'Choose a supported chain.' };\n  }\n\n  function decodePermissions(address) {\n    const value = Number(BigInt(address) & 0x3fffn);\n    return {\n      value,\n      flags: PERMISSION_FLAGS.map((name, index) => ({\n        name,\n        bit: 13 - index,\n        enabled: Boolean(value & (1 << (13 - index))),\n      })),\n    };\n  }\n\n  function candidateKey(candidate) {\n    return String(candidate.chainId) + ':' + String(candidate.address).toLowerCase();\n  }\n\n  function fingerprintOf(evidence) {\n    const fingerprint = evidence && evidence.runtimeFingerprint;\n    if (fingerprint && typeof fingerprint === 'object') return cleanString(fingerprint.fingerprint, 128);\n    return cleanString(fingerprint, 128);\n  }\n\n  function blankModel() {\n    const id = makeId('list');\n    return { version: 3, activeListId: id, lists: [{ id, name: 'Primary', createdAt: Date.now(), items: [] }] };\n  }\n\n  function normalizePermissions(raw, address) {\n    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.flags)) return decodePermissions(address);\n    const byName = new Map(raw.flags.map((flag) => [flag && flag.name, flag]));\n    const fallback = decodePermissions(address);\n    return {\n      value: Number.isFinite(Number(raw.value)) ? Number(raw.value) : fallback.value,\n      flags: PERMISSION_FLAGS.map((name, index) => {\n        const flag = byName.get(name);\n        return { name, bit: 13 - index, enabled: flag ? Boolean(flag.enabled) : fallback.flags[index].enabled };\n      }),\n    };\n  }\n\n  function normalizeEvidence(raw, chainId, address) {\n    if (!raw || typeof raw !== 'object') return null;\n    const codeByteLength = Number(raw.codeByteLength);\n    const latencyMs = Number(raw.latencyMs);\n    const ownerCheck = validateAddress(raw.owner);\n    const fingerprint = fingerprintOf(raw);\n    return {\n      chainId,\n      chainIdHex: cleanString(raw.chainIdHex, 24),\n      name: cleanString(raw.name, 80) || CHAINS[chainId].name,\n      address,\n      upstream: cleanString(raw.upstream, 240),\n      codeByteLength: Number.isFinite(codeByteLength) && codeByteLength >= 0 ? codeByteLength : null,\n      runtimeFingerprint: fingerprint ? { algorithm: 'SHA-256', fingerprint } : null,\n      owner: ownerCheck.ok ? ownerCheck.address : null,\n      ownerProbeStatus: cleanString(raw.ownerProbeStatus, 80),\n      ownerProbeError: cleanString(raw.ownerProbeError, 300) || null,\n      permissions: normalizePermissions(raw.permissions, address),\n      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,\n    };\n  }\n\n  function normalizeObservation(raw, chainId, address) {\n    if (!raw || typeof raw !== 'object') return null;\n    const observedAt = Number(raw.observedAt != null ? raw.observedAt : raw.timestamp);\n    const block = Number(raw.block != null ? raw.block : raw.latestBlock);\n    const codeByteLength = Number(raw.codeByteLength);\n    const latencyMs = Number(raw.latencyMs);\n    const ownerCheck = validateAddress(raw.owner || raw.probeOwner);\n    const fingerprint = fingerprintOf(raw) || cleanString(raw.fingerprint, 128);\n    return {\n      observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),\n      chainId,\n      address,\n      block: Number.isSafeInteger(block) && block >= 0 ? block : null,\n      codeByteLength: Number.isFinite(codeByteLength) && codeByteLength >= 0 ? codeByteLength : null,\n      runtimeFingerprint: fingerprint ? { algorithm: 'SHA-256', fingerprint } : null,\n      owner: ownerCheck.ok ? ownerCheck.address : null,\n      ownerProbeStatus: cleanString(raw.ownerProbeStatus, 80),\n      ownerProbeError: cleanString(raw.ownerProbeError, 300) || null,\n      permissions: normalizePermissions(raw.permissions, address),\n      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,\n    };\n  }\n\n  function normalizeItem(raw, strict) {\n    if (!raw || typeof raw !== 'object') {\n      if (strict) throw new Error('Every imported item must be an object.');\n      return null;\n    }\n    const chain = validateChainId(raw.chainId);\n    const address = validateAddress(raw.address);\n    if (!chain.ok || !address.ok) {\n      if (strict) throw new Error('An imported item has an unsupported chain or invalid address.');\n      return null;\n    }\n    let evidence = normalizeEvidence(raw.evidence, chain.chainId, address.address);\n    if (!evidence && (raw.codeByteLength != null || raw.runtimeFingerprint || raw.permissions)) {\n      evidence = normalizeEvidence(raw, chain.chainId, address.address);\n    }\n    const observations = Array.isArray(raw.observations)\n      ? raw.observations.map((value) => normalizeObservation(value, chain.chainId, address.address)).filter(Boolean).slice(-MAX_OBSERVATIONS)\n      : [];\n    return {\n      id: cleanString(raw.id, 120) || makeId('contract'),\n      chainId: chain.chainId,\n      address: address.address,\n      label: cleanString(raw.label, 80) || null,\n      evidence,\n      observations,\n      lastError: cleanString(raw.lastError, 300) || null,\n      lastAttemptAt: Number.isFinite(Number(raw.lastAttemptAt)) ? Number(raw.lastAttemptAt) : null,\n    };\n  }\n\n  function normalizeList(raw, strict, index) {\n    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {\n      if (strict) throw new Error('Every imported list must include an items array.');\n      return null;\n    }\n    if (raw.items.length > MAX_ITEMS_PER_LIST) throw new Error('A list exceeds the 100-contract limit.');\n    const deduped = [];\n    const keys = new Set();\n    raw.items.forEach((item) => {\n      const normalized = normalizeItem(item, strict);\n      if (!normalized) return;\n      const key = candidateKey(normalized);\n      if (!keys.has(key)) {\n        keys.add(key);\n        deduped.push(normalized);\n      }\n    });\n    return {\n      id: cleanString(raw.id, 120) || makeId('list'),\n      name: cleanString(raw.name, 60) || 'Imported ' + (index + 1),\n      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),\n      items: deduped,\n    };\n  }\n\n  function normalizeModel(raw, strict) {\n    if (!raw || typeof raw !== 'object' || raw.version !== 3 || !Array.isArray(raw.lists)) {\n      if (strict) throw new Error('Import must use the Hookline watchlists v3 format.');\n      return null;\n    }\n    if (!raw.lists.length || raw.lists.length > MAX_LISTS) {\n      if (strict) throw new Error('Import must contain between 1 and 20 lists.');\n      return null;\n    }\n    const lists = raw.lists.map((list, index) => normalizeList(list, strict, index)).filter(Boolean);\n    if (!lists.length) return null;\n    const active = lists.some((list) => list.id === raw.activeListId) ? raw.activeListId : lists[0].id;\n    return { version: 3, activeListId: active, lists };\n  }\n\n  function migrateV2() {\n    try {\n      const parsed = JSON.parse(localStorage.getItem(WATCHLISTS_V2_KEY) || 'null');\n      if (!Array.isArray(parsed) || !parsed.length) return null;\n      const id = makeId('list');\n      const items = [];\n      const keys = new Set();\n      parsed.slice(0, MAX_ITEMS_PER_LIST).forEach((raw) => {\n        const item = normalizeItem(raw, false);\n        if (item && !keys.has(candidateKey(item))) {\n          keys.add(candidateKey(item));\n          items.push(item);\n        }\n      });\n      return { version: 3, activeListId: id, lists: [{ id, name: 'Primary', createdAt: Date.now(), items }] };\n    } catch (_) {\n      return null;\n    }\n  }\n\n  function loadModel() {\n    try {\n      const stored = JSON.parse(localStorage.getItem(WATCHLISTS_KEY) || 'null');\n      const normalized = normalizeModel(stored, false);\n      if (normalized) return normalized;\n    } catch (_) {}\n    return migrateV2() || blankModel();\n  }\n\n  function saveModel() {\n    try {\n      localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(state.model));\n    } catch (error) {\n      console.warn('[hookline] local storage unavailable', error);\n      toast('Browser storage is unavailable. Changes will last for this tab only.', 'alert');\n    }\n    updateDeskCounters();\n  }\n\n  function activeList() {\n    return state.model.lists.find((list) => list.id === state.model.activeListId) || state.model.lists[0];\n  }\n\n  function selectedCandidate() {\n    const list = activeList();\n    return list ? list.items.find((item) => item.id === state.selectedId) || null : null;\n  }\n\n  function lastObservation(candidate) {\n    return candidate && candidate.observations.length ? candidate.observations[candidate.observations.length - 1] : null;\n  }\n\n  function freshness(candidate) {\n    if (candidate.lastError) return 'error';\n    const observation = lastObservation(candidate);\n    if (!observation) return 'unobserved';\n    return Date.now() - observation.observedAt <= CURRENT_WINDOW_MS ? 'current' : 'stale';\n  }\n\n  function totalObservations() {\n    return state.model.lists.reduce((listTotal, list) => (\n      listTotal + list.items.reduce((itemTotal, item) => itemTotal + item.observations.length, 0)\n    ), 0);\n  }\n\n  let rpcSequence = 0;\n  async function rpcCall(method, params) {\n    const response = await fetch('/rpc', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 'desk-' + Date.now() + '-' + ++rpcSequence }),\n    });\n    let payload;\n    try {\n      payload = await response.json();\n    } catch (_) {\n      throw new Error('Hookline RPC returned an unreadable response.');\n    }\n    if (!response.ok || payload.error) {\n      throw new Error(payload && payload.error ? payload.error.message : 'Hookline RPC request failed.');\n    }\n    return payload.result;\n  }\n\n  async function readHook(chainId, address) {\n    const startedAt = performance.now();\n    const [hook, chainStatus] = await Promise.all([\n      rpcCall('hookline_getHook', [chainId, address]),\n      rpcCall('hookline_chainStatus', [chainId]).catch(() => null),\n    ]);\n    if (!hook || typeof hook !== 'object' || !hook.permissions) throw new Error('Hookline returned incomplete contract evidence.');\n    if (!Number.isFinite(hook.codeByteLength) || hook.codeByteLength === 0) {\n      throw new Error('No deployed bytecode was found at this address on the selected chain.');\n    }\n    const evidence = normalizeEvidence(hook, chainId, address);\n    const observation = normalizeObservation({\n      observedAt: Date.now(),\n      block: chainStatus && chainStatus.status === 'healthy' ? chainStatus.blockNumber : null,\n      codeByteLength: evidence.codeByteLength,\n      runtimeFingerprint: evidence.runtimeFingerprint,\n      owner: evidence.owner,\n      ownerProbeStatus: evidence.ownerProbeStatus,\n      ownerProbeError: evidence.ownerProbeError,\n      permissions: evidence.permissions,\n      latencyMs: Number.isFinite(evidence.latencyMs) ? evidence.latencyMs : performance.now() - startedAt,\n    }, chainId, address);\n    return { evidence, observation };\n  }\n\n  function appendData(container, label, value, mono) {\n    container.append(makeElement('div', 'label', label));\n    container.append(makeElement('div', mono ? 'value mono' : 'value', value == null || value === '' ? 'unavailable' : value));\n  }\n\n  function renderPermissions(target, permissions) {\n    target.replaceChildren();\n    const normalized = permissions && Array.isArray(permissions.flags) ? permissions : { flags: [] };\n    normalized.flags.forEach((flag) => {\n      const item = makeElement('div', 'flag');\n      item.setAttribute('aria-pressed', flag.enabled ? 'true' : 'false');\n      item.append(makeElement('span', 'flag-name', flag.name));\n      item.append(makeElement('span', 'flag-val', flag.enabled ? 'enabled · bit ' + flag.bit : 'off · bit ' + flag.bit));\n      target.append(item);\n    });\n  }\n\n  function renderEvidence(target, evidence, observation, error) {\n    target.replaceChildren();\n    appendData(target, 'Chain', evidence ? CHAINS[evidence.chainId].name + ' · ' + evidence.chainId : 'unavailable');\n    appendData(target, 'Address', evidence && evidence.address, true);\n    appendData(target, 'Code size', evidence && Number.isFinite(evidence.codeByteLength) ? formatNumber(evidence.codeByteLength) + ' bytes' : null);\n    appendData(target, 'Runtime SHA-256', evidence && fingerprintOf(evidence), true);\n    appendData(target, 'Owner', evidence && evidence.owner, true);\n    appendData(target, 'Owner probe', evidence && evidence.ownerProbeStatus);\n    appendData(target, 'Observed block', observation && Number.isSafeInteger(observation.block) ? formatNumber(observation.block) : null);\n    appendData(target, 'Observed at', observation && observation.observedAt ? formatDate(observation.observedAt) : null);\n    appendData(target, 'RPC latency', evidence ? formatLatency(evidence.latencyMs) : null);\n    if (error) appendData(target, 'Last refresh error', error);\n  }\n\n  function renderInspected(result) {\n    const heading = $('evidence-heading');\n    $('evidence-empty').hidden = true;\n    heading.textContent = CHAINS[result.evidence.chainId].code + ' · ' + shorten(result.evidence.address, 10, 8);\n    renderEvidence($('inspect-evidence-grid'), result.evidence, result.observation, null);\n    renderPermissions($('inspect-perm-grid'), result.evidence.permissions);\n    $('inspect-permissions').hidden = false;\n    $('inspect-freshness').textContent = 'Observed ' + relativeTime(result.observation.observedAt) + '. Evidence reflects one live RPC read.';\n    $('save-inspect-btn').disabled = false;\n  }\n\n  async function handleInspect(event) {\n    event.preventDefault();\n    const chain = validateChainId($('inspect-chain').value);\n    const address = validateAddress($('inspect-address').value);\n    const errorNode = $('inspect-form-error');\n    errorNode.textContent = '';\n    if (!chain.ok || !address.ok) {\n      errorNode.textContent = chain.ok ? address.message : chain.message;\n      return;\n    }\n    const button = $('inspect-btn');\n    button.disabled = true;\n    button.textContent = 'Inspecting…';\n    $('save-inspect-btn').disabled = true;\n    try {\n      const result = await readHook(chain.chainId, address.address);\n      state.inspected = result;\n      state.inspectionsThisSession += 1;\n      renderInspected(result);\n      updateDeskCounters();\n      toast('Live evidence captured.', 'info');\n    } catch (error) {\n      state.inspected = null;\n      errorNode.textContent = error.message;\n      $('evidence-heading').textContent = 'Inspection failed';\n      $('evidence-empty').hidden = false;\n      $('evidence-empty').textContent = error.message;\n      $('inspect-evidence-grid').replaceChildren();\n      $('inspect-permissions').hidden = true;\n    } finally {\n      button.disabled = false;\n      button.textContent = 'Inspect hook';\n    }\n  }\n\n  function saveInspected() {\n    if (!state.inspected) return toast('Inspect an address before saving it.', 'alert');\n    const list = activeList();\n    const key = candidateKey(state.inspected.evidence);\n    if (list.items.some((candidate) => candidateKey(candidate) === key)) return toast('That contract is already in the active list.', 'alert');\n    if (list.items.length >= MAX_ITEMS_PER_LIST) return toast('The active list is at its 100-contract limit.', 'alert');\n    const candidate = {\n      id: makeId('contract'),\n      chainId: state.inspected.evidence.chainId,\n      address: state.inspected.evidence.address,\n      label: cleanString($('inspect-label').value, 80) || null,\n      evidence: state.inspected.evidence,\n      observations: [state.inspected.observation],\n      lastError: null,\n      lastAttemptAt: Date.now(),\n    };\n    list.items.push(candidate);\n    state.selectedId = candidate.id;\n    saveModel();\n    renderWatchlists();\n    toast('Saved to ' + list.name + '.', 'info');\n  }\n\n  function createList() {\n    if (state.model.lists.length >= MAX_LISTS) return toast('The 20-list limit has been reached.', 'alert');\n    const name = cleanString(window.prompt('Name this watchlist:'), 60);\n    if (!name) return;\n    const list = { id: makeId('list'), name, createdAt: Date.now(), items: [] };\n    state.model.lists.push(list);\n    state.model.activeListId = list.id;\n    state.selectedId = null;\n    saveModel();\n    renderWatchlists();\n  }\n\n  function renameList(list) {\n    const name = cleanString(window.prompt('Rename this watchlist:', list.name), 60);\n    if (!name || name === list.name) return;\n    list.name = name;\n    saveModel();\n    renderWatchlists();\n  }\n\n  function deleteList(list) {\n    if (state.model.lists.length === 1) return toast('The final watchlist cannot be deleted.', 'alert');\n    if (!window.confirm('Delete \"' + list.name + '\" and its saved local evidence?')) return;\n    state.model.lists = state.model.lists.filter((candidate) => candidate.id !== list.id);\n    if (state.model.activeListId === list.id) state.model.activeListId = state.model.lists[0].id;\n    state.selectedId = null;\n    saveModel();\n    renderWatchlists();\n  }\n\n  function renderListRail() {\n    const target = $('lists-list');\n    target.replaceChildren();\n    state.model.lists.forEach((list) => {\n      const item = makeElement('li', 'list-item' + (list.id === state.model.activeListId ? ' active' : ''));\n      const select = makeElement('button', 'list-select');\n      select.type = 'button';\n      select.setAttribute('aria-current', list.id === state.model.activeListId ? 'true' : 'false');\n      select.append(makeElement('span', 'list-name', list.name));\n      select.append(makeElement('span', 'list-count', String(list.items.length)));\n      select.addEventListener('click', () => {\n        state.model.activeListId = list.id;\n        state.selectedId = null;\n        saveModel();\n        renderWatchlists();\n      });\n      const actions = makeElement('span', 'list-item-menu');\n      const rename = makeElement('button', 'list-mini-action', 'Rename');\n      rename.type = 'button';\n      rename.addEventListener('click', () => renameList(list));\n      const remove = makeElement('button', 'list-mini-action', 'Delete');\n      remove.type = 'button';\n      remove.disabled = state.model.lists.length === 1;\n      remove.addEventListener('click', () => deleteList(list));\n      actions.append(rename, remove);\n      item.append(select, actions);\n      target.append(item);\n    });\n    const total = state.model.lists.reduce((sum, list) => sum + list.items.length, 0);\n    $('lists-stats').textContent = state.model.lists.length + ' list' + (state.model.lists.length === 1 ? '' : 's') + ' · ' + total + ' saved contract' + (total === 1 ? '' : 's');\n  }\n\n  function filteredCandidates() {\n    const list = activeList();\n    const query = $('watchlist-search').value.trim().toLowerCase();\n    const chain = $('watchlist-chain-filter').value;\n    const stateFilter = $('watchlist-state-filter').value;\n    return list.items.filter((candidate) => {\n      if (chain !== 'all' && String(candidate.chainId) !== chain) return false;\n      if (stateFilter !== 'all' && freshness(candidate) !== stateFilter) return false;\n      if (query && !((candidate.label || '') + ' ' + candidate.address).toLowerCase().includes(query)) return false;\n      return true;\n    });\n  }\n\n  function makeStatusChip(status) {\n    const chip = makeElement('span', 'status-chip ' + status);\n    chip.append(makeElement('span', 'status-dot'));\n    chip.append(document.createTextNode(status));\n    return chip;\n  }\n\n  function renderWatchTable() {\n    const list = activeList();\n    const items = filteredCandidates();\n    const tbody = $('watchlist-tbody');\n    tbody.replaceChildren();\n    $('active-list-name').textContent = list.name;\n    $('refresh-list-btn').disabled = state.refreshing || list.items.length === 0;\n    const empty = $('watchlist-empty');\n    const table = $('watchlist-table');\n    empty.hidden = items.length !== 0;\n    table.hidden = items.length === 0;\n    if (!items.length) {\n      empty.textContent = list.items.length ? 'No contracts match the active filters.' : 'No contracts saved here. Inspect a live address, then save the evidence to this list.';\n    }\n    items.forEach((candidate) => {\n      const observation = lastObservation(candidate);\n      const row = document.createElement('tr');\n      if (candidate.id === state.selectedId) row.classList.add('selected');\n      row.tabIndex = 0;\n      row.setAttribute('aria-label', (candidate.label || candidate.address) + ' on ' + CHAINS[candidate.chainId].name);\n      const chainCell = document.createElement('td');\n      chainCell.append(makeElement('span', 'chain-chip', CHAINS[candidate.chainId].code));\n      const addressCell = document.createElement('td');\n      addressCell.append(makeElement('strong', 'contract-label', candidate.label || shorten(candidate.address, 9, 7)));\n      addressCell.append(makeElement('code', 'address', candidate.address));\n      const observedCell = makeElement('td', '', observation ? relativeTime(observation.observedAt) : 'never');\n      const blockCell = makeElement('td', 'mono', observation && Number.isSafeInteger(observation.block) ? formatNumber(observation.block) : 'unavailable');\n      const ownerCell = makeElement('td', 'owner mono', candidate.evidence && candidate.evidence.owner ? shorten(candidate.evidence.owner, 7, 5) : 'unavailable');\n      const stateCell = document.createElement('td');\n      stateCell.append(makeStatusChip(freshness(candidate)));\n      const actionCell = document.createElement('td');\n      const refresh = makeElement('button', 'btn btn-ghost btn-compact', 'Refresh');\n      refresh.type = 'button';\n      refresh.addEventListener('click', (event) => {\n        event.stopPropagation();\n        refreshOne(candidate, refresh);\n      });\n      actionCell.append(refresh);\n      row.append(chainCell, addressCell, observedCell, blockCell, ownerCell, stateCell, actionCell);\n      const selectRow = () => {\n        state.selectedId = candidate.id;\n        renderWatchTable();\n        renderDetail();\n      };\n      row.addEventListener('click', selectRow);\n      row.addEventListener('keydown', (event) => {\n        if (event.key === 'Enter' || event.key === ' ') {\n          event.preventDefault();\n          selectRow();\n        }\n      });\n      tbody.append(row);\n    });\n  }\n\n  function populateCompare() {\n    const list = activeList();\n    ['cmp-left', 'cmp-right'].forEach((id) => {\n      const select = $(id);\n      const previous = select.value;\n      select.replaceChildren();\n      const first = document.createElement('option');\n      first.value = '';\n      first.textContent = 'Select a contract';\n      select.append(first);\n      list.items.forEach((candidate) => {\n        const option = document.createElement('option');\n        option.value = candidate.id;\n        option.textContent = CHAINS[candidate.chainId].code + ' · ' + (candidate.label || shorten(candidate.address, 9, 6));\n        select.append(option);\n      });\n      if (list.items.some((candidate) => candidate.id === previous)) select.value = previous;\n    });\n  }\n\n  function renderDetail() {\n    const detail = $('watchlist-detail');\n    const candidate = selectedCandidate();\n    if (!candidate) {\n      detail.hidden = true;\n      return;\n    }\n    detail.hidden = false;\n    $('detail-label').textContent = candidate.label || shorten(candidate.address, 12, 10);\n    renderEvidence($('detail-evidence'), candidate.evidence, lastObservation(candidate), candidate.lastError);\n    renderPermissions($('detail-perm-grid'), candidate.evidence ? candidate.evidence.permissions : decodePermissions(candidate.address));\n  }\n\n  function renderWatchlists() {\n    renderListRail();\n    renderWatchTable();\n    populateCompare();\n    renderDetail();\n    updateDeskCounters();\n  }\n\n  async function updateCandidate(candidate) {\n    candidate.lastAttemptAt = Date.now();\n    try {\n      const result = await readHook(candidate.chainId, candidate.address);\n      candidate.evidence = result.evidence;\n      candidate.observations.push(result.observation);\n      candidate.observations = candidate.observations.slice(-MAX_OBSERVATIONS);\n      candidate.lastError = null;\n      saveModel();\n      return true;\n    } catch (error) {\n      candidate.lastError = cleanString(error.message, 300) || 'Refresh failed.';\n      saveModel();\n      throw error;\n    }\n  }\n\n  async function refreshOne(candidate, button) {\n    if (button) {\n      button.disabled = true;\n      button.textContent = 'Refreshing…';\n    }\n    try {\n      await updateCandidate(candidate);\n      toast('Contract evidence refreshed.', 'info');\n    } catch (error) {\n      toast(error.message + ' Last successful evidence was preserved.', 'alert');\n    } finally {\n      if (button) {\n        button.disabled = false;\n        button.textContent = 'Refresh';\n      }\n      renderWatchlists();\n    }\n  }\n\n  async function refreshActiveList() {\n    const list = activeList();\n    if (!list.items.length || state.refreshing) return;\n    state.refreshing = true;\n    renderWatchTable();\n    const progress = $('refresh-progress');\n    progress.hidden = false;\n    progress.max = list.items.length;\n    progress.value = 0;\n    let cursor = 0;\n    let completed = 0;\n    let succeeded = 0;\n    let failed = 0;\n    async function worker() {\n      while (cursor < list.items.length) {\n        const candidate = list.items[cursor++];\n        try {\n          await updateCandidate(candidate);\n          succeeded += 1;\n        } catch (_) {\n          failed += 1;\n        } finally {\n          completed += 1;\n          progress.value = completed;\n        }\n      }\n    }\n    await Promise.all([worker(), worker()]);\n    state.refreshing = false;\n    progress.hidden = true;\n    renderWatchlists();\n    toast('Refresh finished: ' + succeeded + ' current, ' + failed + ' error' + (failed === 1 ? '' : 's') + '.', failed ? 'alert' : 'info');\n  }\n\n  function removeSelected() {\n    const list = activeList();\n    const candidate = selectedCandidate();\n    if (!candidate) return;\n    if (!window.confirm('Remove ' + (candidate.label || candidate.address) + ' from this list?')) return;\n    list.items = list.items.filter((item) => item.id !== candidate.id);\n    state.selectedId = null;\n    saveModel();\n    renderWatchlists();\n  }\n\n  function compareCandidates(left, right) {\n    const result = $('cmp-result');\n    result.replaceChildren();\n    if (!left || !right) {\n      result.append(makeElement('p', 'comp-refusal', 'Select two contracts to compare.'));\n      return;\n    }\n    if (left.id === right.id) {\n      result.append(makeElement('p', 'comp-refusal', 'Choose two different contracts.'));\n      return;\n    }\n    if (left.chainId !== right.chainId) {\n      result.append(makeElement('p', 'comp-refusal', 'Cross-chain comparison refused. Select two contracts on the same chain.'));\n      return;\n    }\n    const panel = makeElement('div', 'comp-ok');\n    const rows = [\n      ['Chain', CHAINS[left.chainId].name],\n      ['Runtime fingerprint', fingerprintOf(left.evidence) && fingerprintOf(left.evidence) === fingerprintOf(right.evidence) ? 'match' : 'different or unavailable'],\n      ['Owner', left.evidence && right.evidence && left.evidence.owner === right.evidence.owner ? 'match' : 'different or unavailable'],\n      ['Code size', (left.evidence && left.evidence.codeByteLength != null ? left.evidence.codeByteLength : 'unavailable') + ' / ' + (right.evidence && right.evidence.codeByteLength != null ? right.evidence.codeByteLength : 'unavailable')],\n      ['Observed blocks', (lastObservation(left)?.block ?? 'unavailable') + ' / ' + (lastObservation(right)?.block ?? 'unavailable')],\n    ];\n    rows.forEach(([label, value]) => {\n      const row = makeElement('div', 'cmp-result-row');\n      row.append(makeElement('span', 'label', label));\n      row.append(makeElement('code', '', value));\n      panel.append(row);\n    });\n    const title = makeElement('h3', '', 'Permission delta');\n    panel.append(title);\n    const delta = makeElement('div', 'perm-delta');\n    const leftFlags = normalizePermissions(left.evidence && left.evidence.permissions, left.address).flags;\n    const rightFlags = normalizePermissions(right.evidence && right.evidence.permissions, right.address).flags;\n    leftFlags.forEach((flag, index) => {\n      const row = makeElement('div', 'row');\n      row.append(makeElement('span', 'cell flag-name', flag.name));\n      row.append(makeElement('span', 'cell a' + (flag.enabled ? ' enabled' : ''), flag.enabled ? 'on' : 'off'));\n      row.append(makeElement('span', 'cell b' + (rightFlags[index].enabled ? ' enabled' : ''), rightFlags[index].enabled ? 'on' : 'off'));\n      row.append(makeElement('span', 'cell ' + (flag.enabled === rightFlags[index].enabled ? 'same' : 'diff'), flag.enabled === rightFlags[index].enabled ? 'same' : 'changed'));\n      delta.append(row);\n    });\n    panel.append(delta);\n    result.append(panel);\n  }\n\n  function handleCompare(event) {\n    event.preventDefault();\n    const list = activeList();\n    compareCandidates(\n      list.items.find((item) => item.id === $('cmp-left').value),\n      list.items.find((item) => item.id === $('cmp-right').value),\n    );\n  }\n\n  function exportWatchlists() {\n    const blob = new Blob([JSON.stringify(state.model, null, 2)], { type: 'application/json' });\n    const url = URL.createObjectURL(blob);\n    const anchor = document.createElement('a');\n    anchor.href = url;\n    anchor.download = 'hookline-watchlists-' + new Date().toISOString().slice(0, 10) + '.json';\n    document.body.append(anchor);\n    anchor.click();\n    anchor.remove();\n    URL.revokeObjectURL(url);\n    toast('Watchlists exported.', 'info');\n  }\n\n  function uniqueImportedName(name) {\n    const names = new Set(state.model.lists.map((list) => list.name.toLowerCase()));\n    if (!names.has(name.toLowerCase())) return name;\n    let suffix = 2;\n    while (names.has((name + ' import ' + suffix).toLowerCase())) suffix += 1;\n    return name + ' import ' + suffix;\n  }\n\n  async function importWatchlists(file) {\n    if (!file) return;\n    if (file.size > MAX_IMPORT_BYTES) throw new Error('Import exceeds the 1 MB file limit.');\n    let parsed;\n    try {\n      parsed = JSON.parse(await file.text());\n    } catch (_) {\n      throw new Error('Import is not valid JSON.');\n    }\n    const incoming = normalizeModel(parsed, true);\n    if (state.model.lists.length + incoming.lists.length > MAX_LISTS) {\n      throw new Error('Import would exceed the 20-list total limit.');\n    }\n    incoming.lists.forEach((list) => {\n      const keys = new Set();\n      list.id = makeId('list');\n      list.name = uniqueImportedName(list.name);\n      list.items = list.items.filter((item) => {\n        const key = candidateKey(item);\n        if (keys.has(key)) return false;\n        keys.add(key);\n        item.id = makeId('contract');\n        return true;\n      });\n      state.model.lists.push(list);\n    });\n    saveModel();\n    renderWatchlists();\n    toast(incoming.lists.length + ' list' + (incoming.lists.length === 1 ? '' : 's') + ' imported.', 'info');\n  }\n\n  function metricStat(label, value) {\n    const stat = makeElement('div', 'stat');\n    stat.append(makeElement('span', 'stat-label', label));\n    stat.append(makeElement('strong', 'stat-value', value));\n    return stat;\n  }\n\n  function renderTelemetry(metrics) {\n    const summary = $('telemetry-summary');\n    const body = $('chain-table-body');\n    summary.replaceChildren();\n    body.replaceChildren();\n    if (!metrics) {\n      summary.append(metricStat('Telemetry', 'unavailable'));\n      const row = document.createElement('tr');\n      const cell = makeElement('td', '', 'Live chain telemetry is unavailable.');\n      cell.colSpan = 6;\n      row.append(cell);\n      body.append(row);\n      $('observe-health').textContent = 'unavailable';\n      $('observe-base-block').textContent = 'unavailable';\n      return;\n    }\n    summary.append(\n      metricStat('Healthy chains', metrics.healthyChains + ' / ' + metrics.supportedChains),\n      metricStat('Base latest block', metrics.baseLatestBlock == null ? 'unavailable' : formatNumber(metrics.baseLatestBlock)),\n      metricStat('Generated', relativeTime(Date.parse(metrics.generatedAt))),\n      metricStat('Saved observations', formatNumber(totalObservations())),\n    );\n    $('observe-health').textContent = metrics.healthyChains + ' / ' + metrics.supportedChains;\n    $('observe-base-block').textContent = metrics.baseLatestBlock == null ? 'unavailable' : formatNumber(metrics.baseLatestBlock);\n    metrics.chains.forEach((chain) => {\n      const row = document.createElement('tr');\n      const status = document.createElement('td');\n      status.append(makeStatusChip(chain.healthy ? 'current' : 'error'));\n      status.lastChild.lastChild.textContent = chain.healthy ? 'healthy' : 'error';\n      row.append(\n        makeElement('td', '', chain.name || CHAINS[chain.chainId]?.name || 'Unknown'),\n        makeElement('td', 'mono', chain.chainId),\n        status,\n        makeElement('td', 'mono', chain.blockNumber == null ? 'unavailable' : formatNumber(chain.blockNumber)),\n        makeElement('td', 'mono', formatLatency(chain.latencyMs)),\n        makeElement('td', '', chain.error || 'none'),\n      );\n      body.append(row);\n    });\n  }\n\n  function validMetrics(raw) {\n    if (!raw || !Array.isArray(raw.chains)) return null;\n    const supportedChains = Number(raw.supportedChains);\n    const healthyChains = Number(raw.healthyChains);\n    if (!Number.isInteger(supportedChains) || !Number.isInteger(healthyChains)) return null;\n    return {\n      supportedChains,\n      healthyChains,\n      baseLatestBlock: Number.isSafeInteger(raw.baseLatestBlock) ? raw.baseLatestBlock : null,\n      generatedAt: cleanString(raw.generatedAt, 80),\n      chains: raw.chains.map((chain) => ({\n        chainId: Number(chain.chainId),\n        name: cleanString(chain.name, 80),\n        healthy: Boolean(chain.healthy),\n        blockNumber: Number.isSafeInteger(chain.blockNumber) ? chain.blockNumber : null,\n        latencyMs: Number.isFinite(Number(chain.latencyMs)) ? Number(chain.latencyMs) : null,\n        error: cleanString(chain.error, 300) || null,\n      })),\n    };\n  }\n\n  function renderTopStatus() {\n    const node = $('top-live');\n    node.className = 'live-indicator';\n    if (state.healthOk === false) {\n      node.classList.add('offline');\n      node.textContent = 'OFFLINE';\n    } else if (state.metrics && state.metrics.healthyChains < state.metrics.supportedChains) {\n      node.classList.add('loading');\n      node.textContent = 'PARTIAL ' + state.metrics.healthyChains + '/' + state.metrics.supportedChains;\n    } else if (state.healthOk === true || (state.metrics && state.metrics.healthyChains > 0)) {\n      node.classList.add('live');\n      node.textContent = 'LIVE';\n    } else {\n      node.classList.add('loading');\n      node.textContent = 'PROBING';\n    }\n  }\n\n  async function loadTelemetry(showMessage) {\n    const button = $('refresh-telemetry-btn');\n    button.disabled = true;\n    try {\n      const response = await fetch('/metrics', { headers: { Accept: 'application/json' } });\n      if (!response.ok) throw new Error('Metrics request failed.');\n      const metrics = validMetrics(await response.json());\n      if (!metrics) throw new Error('Metrics response was incomplete.');\n      state.metrics = metrics;\n      renderTelemetry(metrics);\n      if (showMessage) toast('Network telemetry refreshed.', 'info');\n    } catch (error) {\n      state.metrics = null;\n      renderTelemetry(null);\n      if (showMessage) toast(error.message, 'alert');\n    } finally {\n      button.disabled = false;\n      renderTopStatus();\n    }\n  }\n\n  async function loadHealth() {\n    try {\n      const response = await fetch('/health', { headers: { Accept: 'application/json' } });\n      const body = response.ok ? await response.json() : null;\n      state.healthOk = Boolean(body && body.status === 'live');\n    } catch (_) {\n      state.healthOk = false;\n    }\n    renderTopStatus();\n  }\n\n  function updateDeskCounters() {\n    $('observe-session-count').textContent = formatNumber(state.inspectionsThisSession);\n    $('observe-saved-count').textContent = formatNumber(totalObservations());\n  }\n\n  function viewFromHash() {\n    const value = location.hash.replace(/^#\\/?/, '') || 'observatory';\n    return VIEWS.has(value) ? value : 'observatory';\n  }\n\n  function renderView() {\n    const view = viewFromHash();\n    $$('.view').forEach((section) => section.classList.toggle('active', section.id === 'view-' + view));\n    $$('[data-view]').forEach((link) => {\n      const active = link.dataset.view === view;\n      link.classList.toggle('active', active);\n      if (active) link.setAttribute('aria-current', 'page');\n      else link.removeAttribute('aria-current');\n    });\n    if (view === 'watchlists') renderWatchlists();\n    if (view === 'network') renderTelemetry(state.metrics);\n    window.scrollTo(0, 0);\n  }\n\n  function toast(message, kind) {\n    const node = $('hookline-toast');\n    node.textContent = message;\n    node.className = 'toast show ' + (kind || 'info');\n    clearTimeout(state.toastTimer);\n    state.toastTimer = setTimeout(() => { node.className = 'toast'; }, 4200);\n  }\n\n  async function copyText(value, button) {\n    const text = value.startsWith('/') ? location.origin + value : value;\n    try {\n      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);\n      else {\n        const area = document.createElement('textarea');\n        area.value = text;\n        area.style.position = 'fixed';\n        area.style.opacity = '0';\n        document.body.append(area);\n        area.select();\n        document.execCommand('copy');\n        area.remove();\n      }\n      if (button) {\n        const original = button.textContent;\n        button.textContent = 'Copied';\n        button.classList.add('copied');\n        setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1400);\n      }\n      toast('Copied to clipboard.', 'info');\n    } catch (_) {\n      toast('Copy failed. Select the value manually.', 'alert');\n    }\n  }\n\n  function setupWebMCP() {\n    if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') return;\n    const tools = [\n      {\n        name: 'inspect_hook',\n        description: 'Fetch live Hookline evidence for one supported-chain contract.',\n        inputSchema: { type: 'object', required: ['chainId', 'address'], additionalProperties: false, properties: { chainId: { type: 'integer', enum: SUPPORTED_CHAINS }, address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } } },\n        annotations: { readOnlyHint: true, untrustedContentHint: false },\n        execute: async ({ chainId, address }) => {\n          const chain = validateChainId(chainId);\n          const checked = validateAddress(address);\n          if (!chain.ok || !checked.ok) throw new Error(chain.ok ? checked.message : chain.message);\n          return readHook(chain.chainId, checked.address);\n        },\n      },\n      {\n        name: 'decode_hook_address',\n        description: 'Decode the canonical 14 permission bits embedded in a hook address.',\n        inputSchema: { type: 'object', required: ['address'], additionalProperties: false, properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } } },\n        annotations: { readOnlyHint: true, untrustedContentHint: false },\n        execute: async ({ address }) => {\n          const checked = validateAddress(address);\n          if (!checked.ok) throw new Error(checked.message);\n          return decodePermissions(checked.address);\n        },\n      },\n      {\n        name: 'list_hookline_watchlists',\n        description: 'Return locally saved Hookline list names and contract identities.',\n        inputSchema: { type: 'object', additionalProperties: false, properties: {} },\n        annotations: { readOnlyHint: true, untrustedContentHint: false },\n        execute: async () => state.model.lists.map((list) => ({ name: list.name, contracts: list.items.map((item) => ({ chainId: item.chainId, address: item.address, label: item.label, freshness: freshness(item) })) })),\n      },\n    ];\n    tools.forEach((tool) => {\n      try { document.modelContext.registerTool(tool); } catch (error) { console.warn('[hookline] WebMCP registration failed', tool.name, error); }\n    });\n  }\n\n  function setupEvents() {\n    $('inspect-form').addEventListener('submit', handleInspect);\n    $('save-inspect-btn').addEventListener('click', saveInspected);\n    $('new-list-btn').addEventListener('click', createList);\n    $('refresh-list-btn').addEventListener('click', refreshActiveList);\n    $('watchlist-search').addEventListener('input', renderWatchTable);\n    $('watchlist-chain-filter').addEventListener('change', renderWatchTable);\n    $('watchlist-state-filter').addEventListener('change', renderWatchTable);\n    $('add-candidate-btn').addEventListener('click', () => {\n      location.hash = '#/observatory';\n      setTimeout(() => $('inspect-address').focus(), 0);\n    });\n    $('compare-form').addEventListener('submit', handleCompare);\n    $('refresh-candidate-btn').addEventListener('click', () => {\n      const candidate = selectedCandidate();\n      if (candidate) refreshOne(candidate, $('refresh-candidate-btn'));\n    });\n    $('remove-candidate-btn').addEventListener('click', removeSelected);\n    $('close-detail-btn').addEventListener('click', () => { state.selectedId = null; renderWatchlists(); });\n    $('export-btn').addEventListener('click', exportWatchlists);\n    $('import-btn').addEventListener('click', () => $('import-file').click());\n    $('import-file').addEventListener('change', async (event) => {\n      try { await importWatchlists(event.target.files && event.target.files[0]); }\n      catch (error) { toast(error.message, 'alert'); }\n      finally { event.target.value = ''; }\n    });\n    $('refresh-telemetry-btn').addEventListener('click', () => loadTelemetry(true));\n    $('top-copy-ca').addEventListener('click', (event) => copyText(TOKEN_CA, event.currentTarget));\n    $('strip-copy-ca').addEventListener('click', (event) => copyText(TOKEN_CA, event.currentTarget));\n    $('strip-copy-fee').addEventListener('click', (event) => copyText(FEE_WALLET, event.currentTarget));\n    $$('[data-copy]').forEach((button) => button.addEventListener('click', (event) => copyText(button.dataset.copy, event.currentTarget)));\n    window.addEventListener('hashchange', renderView);\n  }\n\n  function init() {\n    state.model = loadModel();\n    saveModel();\n    setupEvents();\n    renderWatchlists();\n    renderView();\n    setupWebMCP();\n    loadHealth();\n    loadTelemetry(false);\n  }\n\n  window.Hookline = {\n    getState: () => JSON.parse(JSON.stringify(state.model)),\n    decodePermissions,\n    validateAddress,\n    inspect: (chainId, address) => readHook(chainId, String(address).toLowerCase()),\n  };\n\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);\n  else init();\n})();\n",
});
// ---------------------------------------------------------------------------
// Immutable public RPC configuration (centralized — never mutated, never
// URL-driven, never environment-variable-driven).
// ---------------------------------------------------------------------------

const CHAIN_CONFIG = Object.freeze({
  1: {
    name: 'Ethereum',
    code: 'ETH',
    upstream: 'https://ethereum-rpc.publicnode.com',
  },
  8453: {
    name: 'Base',
    code: 'BASE',
    upstream: 'https://base-rpc.publicnode.com',
  },
  42161: { name: 'Arbitrum One', code: 'ARB', upstream: 'https://arb1.arbitrum.io/rpc' },
  4663: {
    name: 'Robinhood Chain',
    code: 'RHB',
    upstream: 'https://robinhood.drpc.org',
  },
});

const SUPPORTED_CHAINS = Object.freeze(
  [...Object.keys(CHAIN_CONFIG)].map((k) => Number(k))
);
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 32 * 1024; // 32 KiB (request body cap)
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB (upstream response cap)
const X402_NETWORK = 'eip155:8453';
const X402_PAY_TO = '0x69e73F4B54ED92939D48B5472894179BF3292DD3';
const X402_USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const X402_AMOUNT_ATOMIC = '10000';

// ---------------------------------------------------------------------------
// Rate limiting (per-isolate, best effort): 60 POST RPC requests per minute
// per CF-Connecting-IP. The in-memory map is pruned every check and size-bounded.
// ---------------------------------------------------------------------------
const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_RATE_LIMIT_MAP_SIZE = 10_000;
const rateLimitMap = new Map(); // keys: CF-Connecting-IP values

// The 14 canonical Uniswap v4 hook permission flags, in canonical high-bit
// (bit 13) → low-bit (bit 0) order.
const PERMISSION_FLAGS = Object.freeze([
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap',
  'beforeDonate',
  'afterDonate',
  'beforeSwapReturnDelta',
  'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterRemoveLiquidityReturnDelta',
]);

// The owner() selector used for hook owner probes.
const OWNER_SELECTOR = '0x8da5cb5b';

// ---------------------------------------------------------------------------
// Routing tables.
// ---------------------------------------------------------------------------

const STATIC_ROUTES = Object.freeze({
  '/': { type: 'text/html; charset=utf-8', key: 'html' },
  '/styles.css': { type: 'text/css; charset=utf-8', key: 'css' },
  '/app.js': { type: 'application/javascript; charset=utf-8', key: 'app' },
});

const HOOKLINE_METHODS = new Set([
  'hookline_chains',
  'hookline_decodePermissions',
  'hookline_chainStatus',
  'hookline_getHook',
]);

// Standard Ethereum JSON-RPC methods allowed through the public proxy.
const STANDARD_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_blockNumber',
  'eth_getCode',
  'eth_call',
  'eth_getStorageAt',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_estimateGas',
]);

// ---------------------------------------------------------------------------
// Header helpers.
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = Object.freeze({
  'Strict-Transport-Security':
    'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'",
});

function baseJsonHeaders(extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'false',
    },
    SECURITY_HEADERS,
    extra || {}
  );
}

function makeCORSHeaders(extra) {
  const headers = Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Payment-Signature, X-Payment',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'false',
  });
  if (extra) Object.assign(headers, extra);
  return headers;
}

// ---------------------------------------------------------------------------
// Request body reading and JSON-RPC 2.0 parsing.
// ---------------------------------------------------------------------------

const MAX_JSONRPC_ID = Number.MAX_SAFE_INTEGER;

// A raw JSON-RPC error envelope. 'rawId' is carried so we can echo the id back
// in the error response whenever one is available.
function rpcParseError(code, message, rawId) {
  return { type: 'parse-error', code, message, rawId };
}

function rpcInvalidRequest(code, message, rawId) {
  return { type: 'invalid-request', code, message, rawId };
}

// Parse the incoming request; never throws. Returns either { id, method,
// params } or one of the error shapes above.
async function readJsonRpcBody(request) {
  const lenHeader = request.headers.get('content-length');
  const len = lenHeader ? Number(lenHeader) : NaN;
  if (!Number.isNaN(len) && len > MAX_BODY_BYTES) {
    return rpcParseError(
      -32700,
      `request body too large: ${len} bytes (max ${MAX_BODY_BYTES})`,
      undefined
    );
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return rpcParseError(-32700, 'failed to read request body', undefined);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return rpcParseError(
      -32700,
      `request body too large: ${raw.length} bytes (max ${MAX_BODY_BYTES})`,
      undefined
    );
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return rpcParseError(-32700, 'invalid JSON', undefined);
  }

  const rawBytes = new TextEncoder().encode(raw).byteLength;
  if (rawBytes > MAX_BODY_BYTES) {
    return rpcParseError(
      -32700,
      `request body too large: ${rawBytes} bytes (max ${MAX_BODY_BYTES})`,
      undefined
    );
  }

  if (Array.isArray(obj)) {
    return rpcInvalidRequest(
      -32600,
      'invalid request: batch JSON-RPC requests are not supported',
      undefined
    );
  }
  if (!isJsonRpcObject(obj)) {
    return rpcInvalidRequest(
      -32600,
      'invalid request: body must be a JSON object',
      obj?.id
    );
  }
  if (obj.jsonrpc !== '2.0') {
    return rpcInvalidRequest(
      -32600,
      'invalid request: jsonrpc must be "2.0"',
      obj.id
    );
  }
  if (typeof obj.method !== 'string' || obj.method.trim() === '') {
    return rpcInvalidRequest(
      -32600,
      'invalid request: method is required and must be a non-empty string',
      obj.id
    );
  }
  if (obj.id === undefined || obj.id === null) {
    return rpcInvalidRequest(
      -32600,
      'invalid request: id is required',
      obj.id
    );
  }
  if (typeof obj.id === 'number') {
    if (!Number.isInteger(obj.id) || obj.id < 0 || obj.id > MAX_JSONRPC_ID) {
      return rpcInvalidRequest(
        -32600,
        'invalid request: id must be a string or a non-negative integer',
        obj.id
      );
    }
  }
  if (typeof obj.id !== 'number' && typeof obj.id !== 'string') {
    return rpcInvalidRequest(
      -32600,
      'invalid request: id must be a string or a non-negative integer',
      obj.id
    );
  }
  if (typeof obj.params === 'undefined' || obj.params === null) {
    return rpcInvalidRequest(
      -32600,
      'invalid request: params is required',
      obj.id
    );
  }
  if (!Array.isArray(obj.params)) {
    return rpcInvalidRequest(
      -32600,
      'invalid request: params must be an array',
      obj.id
    );
  }
  return { id: obj.id, method: obj.method, params: obj.params };
}

function isJsonRpcObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Response helpers.
// ---------------------------------------------------------------------------

function makeRpcEnvelope(id, result, error) {
  const envelope = { jsonrpc: '2.0', id };
  if (result !== undefined) envelope.result = result;
  if (error !== undefined) envelope.error = error;
  return envelope;
}

function makeResponse(body, headers) {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status: 200, headers }
  );
}

// A minimal JSON-RPC error reply echoing the id whenever one is available.
function sendRpcError(id, code, message) {
  return makeResponse(
    makeRpcEnvelope(id, undefined, { code, message }),
    baseJsonHeaders()
  );
}

// Normal JSON-RPC reply.
function sendRpcResult(id, result) {
  return makeResponse(makeRpcEnvelope(id, result), baseJsonHeaders());
}

// ---- rate limiting (per-isolate, best effort) ----

function getConnectingIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) return ip.trim();
  return '__none__';
}

function pruneRateLimitMap() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
  // Bound the in-memory map size by evicting the oldest half when full.
  if (rateLimitMap.size >= MAX_RATE_LIMIT_MAP_SIZE) {
    const keys = [...rateLimitMap.keys()];
    for (let i = 0; i < Math.ceil(keys.length / 2); i++) {
      rateLimitMap.delete(keys[i]);
    }
  }
}

function checkRateLimit(ip) {
  pruneRateLimitMap();
  let entry = rateLimitMap.get(ip);
  if (!entry || Date.now() - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: Date.now(), count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_REQUESTS) {
    return {
      tooMany: true,
      retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000) || 1,
    };
  }
  return { tooMany: false };
}

function sendRateLimitError(id, retryAfter) {
  return new Response(
    JSON.stringify(
      makeRpcEnvelope(id, undefined, {
        code: -32029,
        message: `rate limit exceeded: too many requests per minute; retry after ${retryAfter} seconds`,
        retryAfter,
      })
    ),
    {
      status: 429,
      headers: baseJsonHeaders({ 'Retry-After': String(retryAfter) }),
    }
  );
}

// ---------------------------------------------------------------------------
// Upstream RPC caller with a hard timeout.
// ---------------------------------------------------------------------------

// Calls the given upstream for the given payload and returns a plain envelope
// { result?, error? }. Errors are returned as { code, message } objects so the
// caller can decide how far to propagate them.
async function callUpstream(upstream, payload, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        error: {
          code: -32603,
          message: `upstream HTTP error ${res.status}`,
        },
      };
    }
    const upstreamLength = Number(res.headers.get('content-length'));
    if (
      Number.isFinite(upstreamLength) &&
      upstreamLength > MAX_UPSTREAM_RESPONSE_BYTES
    ) {
      return {
        error: {
          code: -32603,
          message: 'upstream response body too large',
        },
      };
    }
    // Cap the upstream response body at 2 MiB before JSON parsing.
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_UPSTREAM_RESPONSE_BYTES) {
      return { error: { code: -32603, message: 'upstream response body too large' } };
    }
    let json;
    try {
      json = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      return { error: { code: -32603, message: 'upstream returned invalid JSON' } };
    }
    if (isJsonRpcObject(json)) {
      if ('error' in json && json.error) {
        return { error: Object.assign({ code: -32000 }, json.error) };
      }
      return { result: json.result };
    }
    return { error: { code: -32603, message: 'upstream response is not JSON-RPC' } };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: { code: -32000, message: `upstream request timed out after ${timeoutMs}ms` } };
    }
    return { error: { code: -32603, message: `upstream error: ${err.message}` } };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Hex / BigInt utilities.
// ---------------------------------------------------------------------------

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_64_RE = /^0x[0-9a-fA-F]{64}$/;

function hexLengthBytes(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return 0;
  return (hex.length - 2) / 2;
}

function hexToBytes(hex) {
  const s = hex.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    out[i / 2] = Number.parseInt(s.slice(i, i + 2), 16);
  }
  return out;
}

async function sha256Hex(bytes) {
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buffer);
  const pieces = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    pieces[i] = arr[i].toString(16).padStart(2, '0');
  }
  return pieces.join('');
}

function sha256HexOfHex(hex) {
  return sha256Hex(hexToBytes(hex));
}

// Robust hex -> safe integer. Accepts '0x' prefix; rejects malformed input and
// values outside the safe-integer range. Never returns NaN.
function hexToInt(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim();
  if (!s.startsWith('0x')) return null;
  const digits = s.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  const num = Number('0x' + digits);
  return Number.isSafeInteger(num) ? num : null;
}

function decodePermissionsLow14(address) {
  const addr = String(address).toLowerCase();
  if (!ETH_ADDR_RE.test(addr)) {
    return { value: 0, flags: [] };
  }
  const masked = BigInt(addr) & 0x3fffn;
  const value = Number(masked);
  const flags = PERMISSION_FLAGS.map((name, i) => ({
    name,
    bit: 13 - i,
    enabled: !!(value & (1 << (13 - i))),
  }));
  return { value, flags };
}

// ---------------------------------------------------------------------------
// Hookline public methods.
// ---------------------------------------------------------------------------

function hookline_chains_handler(params, id) {
  const chains = Object.entries(CHAIN_CONFIG).map(([idKey, cfg]) => ({
    chainId: Number(idKey),
    chainIdHex: '0x' + Number(idKey).toString(16),
    name: cfg.name,
    code: cfg.code,
    upstream: cfg.upstream,
    transaction_submission_supported: false,
  }));
  return { chains };
}

function hookline_decodePermissions_handler(params, id) {
  const address = params[0];
  if (typeof address !== 'string') {
    return rpcInvalidRequest(-32602, 'params[0] must be an address string', id);
  }
  const addr = address.toLowerCase().trim();
  if (!ETH_ADDR_RE.test(addr)) {
    return rpcInvalidRequest(-32602, 'params[0] must be a 0x-prefixed 40-hex address', id);
  }
  const { value, flags } = decodePermissionsLow14(addr);
  return { address: addr, value, flags, bitLength: 14 };
}

async function hookline_chainStatus_handler(params, id, ctx) {
  const chainId = params[0];
  if (!SUPPORTED_CHAINS.includes(chainId)) {
    return rpcInvalidRequest(
      -32602,
      `params[0] must be a supported chainId (${SUPPORTED_CHAINS.join(', ')})`,
      id
    );
  }
  const cfg = CHAIN_CONFIG[chainId];

  const startedAt = performance.now();
  const [chainIdRes, blockRes] = await Promise.all([
    callUpstream(cfg.upstream, { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }, UPSTREAM_TIMEOUT_MS),
    callUpstream(cfg.upstream, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 }, UPSTREAM_TIMEOUT_MS),
  ]);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (chainIdRes.error) {
    return {
      chainId,
      chainIdHex: '0x' + chainId.toString(16),
      name: cfg.name,
      upstream: cfg.upstream,
      latencyMs: elapsedMs,
      status: 'unreachable',
      errors: [chainIdRes.error, blockRes.error || null].filter(Boolean),
    };
  }

  const chainIdNum = hexToInt(chainIdRes.result);
  if (chainIdNum === null) {
    return {
      chainId,
      chainIdHex: '0x' + chainId.toString(16),
      name: cfg.name,
      upstream: cfg.upstream,
      latencyMs: elapsedMs,
      status: 'error',
      errors: [chainIdRes.error || { code: -32603, message: 'malformed eth_chainId response' }],
    };
  }
  if (chainIdNum !== chainId) {
    return {
      chainId,
      chainIdHex: '0x' + chainIdNum.toString(16),
      name: cfg.name,
      upstream: cfg.upstream,
      latencyMs: elapsedMs,
      status: 'error',
      errors: [
        {
          code: -32603,
          message:
            `chain-id mismatch: upstream reported 0x${chainIdNum.toString(16)} but expected 0x${chainId.toString(16)}`,
        },
      ],
    };
  }

  const blockNum = hexToInt(blockRes.result);
  if (blockNum === null) {
    return {
      chainId,
      chainIdHex: '0x' + chainIdNum.toString(16),
      name: cfg.name,
      upstream: cfg.upstream,
      latencyMs: elapsedMs,
      status: 'error',
      errors: [blockRes.error || { code: -32603, message: 'malformed eth_blockNumber response' }],
    };
  }

  return {
    chainId,
    chainIdHex: '0x' + chainIdNum.toString(16),
    name: cfg.name,
    upstream: cfg.upstream,
    blockNumber: blockNum,
    blockNumberHex: blockRes.result,
    latencyMs: elapsedMs,
    status: 'healthy',
  };
}

async function hookline_getHook_handler(params, id, ctx) {
  const chainId = params[0];
  const address = params[1];

  if (!SUPPORTED_CHAINS.includes(chainId)) {
    return rpcInvalidRequest(
      -32602,
      `params[0] must be a supported chainId (${SUPPORTED_CHAINS.join(', ')})`,
      id
    );
  }
  if (typeof address !== 'string') {
    return rpcInvalidRequest(-32602, 'params[1] must be an address string', id);
  }
  const addr = address.toLowerCase().trim();
  if (!ETH_ADDR_RE.test(addr)) {
    return rpcInvalidRequest(-32602, 'params[1] must be a 0x-prefixed 40-hex address', id);
  }

  const cfg = CHAIN_CONFIG[chainId];
  const startedAt = performance.now();

  const codeRes = await callUpstream(
    cfg.upstream,
    { jsonrpc: '2.0', method: 'eth_getCode', params: [addr, 'latest'], id: 1 },
    UPSTREAM_TIMEOUT_MS
  );
  if (codeRes.error) {
    return rpcInvalidRequest(
      -32000,
      `eth_getCode failed for ${addr}: ${codeRes.error.message}`,
      id
    );
  }
  const bytecode = codeRes.result;
  if (
    typeof bytecode !== 'string' ||
    !HEX_RE.test(bytecode) ||
    (bytecode.length - 2) % 2 !== 0
  ) {
    return rpcInvalidRequest(
      -32603,
      `eth_getCode returned malformed bytecode for ${addr}`,
      id
    );
  }
  const codeByteLength = hexLengthBytes(bytecode);
  const runtimeFingerprintHex = await sha256HexOfHex(bytecode);

  // Owner probe — never fails the whole request.
  const probeRes = await callUpstream(
    cfg.upstream,
    {
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: addr, data: OWNER_SELECTOR }, 'latest'],
      id: 2,
    },
    UPSTREAM_TIMEOUT_MS
  );
  let owner = null;
  let ownerProbeStatus = 'ok';
  let ownerProbeError = null;
  if (probeRes.error) {
    // Owner probe error/revert must not fail hookline_getHook.
    owner = null;
    ownerProbeStatus = 'reverted';
    ownerProbeError = probeRes.error.message;
  } else if (typeof probeRes.result === 'string' && HEX_64_RE.test(probeRes.result)) {
    // Valid 32-byte return: parse the last 20 bytes as a lowercase 0x address;
    // the zero address maps to null.
    const hex = probeRes.result.slice(2).toLowerCase();
    const addrHex = hex.slice(-40);
    if (addrHex !== '0'.repeat(40)) {
      owner = '0x' + addrHex;
    }
  } else {
    owner = null;
    ownerProbeStatus = 'no-owner-function';
    ownerProbeError = probeRes.result;
  }

  const { value, flags } = decodePermissionsLow14(addr);
  return {
    chainId,
    chainIdHex: '0x' + chainId.toString(16),
    name: cfg.name,
    address: addr,
    upstream: cfg.upstream,
    codeByteLength,
    runtimeFingerprint: { algorithm: 'SHA-256', fingerprint: runtimeFingerprintHex },
    owner,
    ownerProbeStatus,
    ownerProbeError,
    permissions: { value, flags },
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

async function dispatchHooklineRpc(parsed, id, ctx) {
  let result;
  switch (parsed.method) {
    case 'hookline_chains':
      result = hookline_chains_handler(parsed.params, id);
      break;
    case 'hookline_decodePermissions':
      result = hookline_decodePermissions_handler(parsed.params, id);
      break;
    case 'hookline_chainStatus':
      result = await hookline_chainStatus_handler(parsed.params, id, ctx);
      break;
    case 'hookline_getHook':
      result = await hookline_getHook_handler(parsed.params, id, ctx);
      break;
    default:
      return sendRpcError(id, -32601, `method not found: ${parsed.method}`);
  }

  if (result && typeof result === 'object' && result.type) {
    return sendRpcError(id, result.code, result.message);
  }
  return sendRpcResult(id, result);
}

// ---------------------------------------------------------------------------
// Standard public proxy for POST /rpc/:chainId.
// ---------------------------------------------------------------------------

// Defensive write/admin/trace rejection, complementary to the allowlist below.
function isWriteOrAdminMethod(method) {
  if (method === 'net_version') return false;
  if (method === 'web3_clientVersion') return false;
  if (/^(admin|debug|trace|personal|eth_accounts|eth_requestAccounts)/i.test(method)) {
    return true;
  }
  if (method === 'eth_sendTransaction' || method === 'eth_sendRawTransaction') {
    return true;
  }
  return false;
}

async function proxyStandardRpc(chainId, parsed, id, ctx) {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) {
    return sendRpcError(
      id,
      -32601,
      `unsupported chainId ${chainId} (supported: ${SUPPORTED_CHAINS.join(', ')})`
    );
  }
  if (!STANDARD_METHODS.has(parsed.method)) {
    return sendRpcError(
      id,
      -32601,
      `method not allowed: ${parsed.method} (safe-method JSON-RPC allowlist only)`
    );
  }
  if (isWriteOrAdminMethod(parsed.method)) {
    return sendRpcError(
      id,
      -32601,
      `${parsed.method} is not supported: this endpoint never submits transactions`
    );
  }

  // Full transaction details are not exposed by this public RPC.
  if (parsed.method === 'eth_getBlockByNumber' || parsed.method === 'eth_getBlockByHash') {
    if (parsed.params?.[1] === true) {
      return sendRpcError(
        id,
        -32602,
        'invalid params: full transaction details are not supported; use false or omit the parameter'
      );
    }
  }

  // Rate-cap eth_feeHistory blockCount at 128 (number or 0x-hex).
  if (parsed.method === 'eth_feeHistory') {
    const blockCount = parsed.params?.[0];
    let n = null;
    if (typeof blockCount === 'number') {
      n = blockCount;
    } else if (
      typeof blockCount === 'string' &&
      /^0x[0-9a-fA-F]+$/.test(blockCount)
    ) {
      n = hexToInt(blockCount);
    }
    if (!Number.isSafeInteger(n) || n < 1 || n > 128) {
      return sendRpcError(
        id,
        -32602,
        'invalid params: eth_feeHistory blockCount must be an integer from 1 to 128'
      );
    }
  }

  const startedAt = performance.now();
  const res = await callUpstream(
    cfg.upstream,
    { jsonrpc: '2.0', method: parsed.method, params: parsed.params, id },
    UPSTREAM_TIMEOUT_MS
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (res.error) {
    return sendRpcError(id, res.error.code, res.error.message);
  }
  return sendRpcResult(id, res.result);
}

// ---------------------------------------------------------------------------
async function jsonMetricsBody() {
  const entries = Object.entries(CHAIN_CONFIG);
  const results = await Promise.all(
    entries.map(async ([idKey, cfg]) => {
      const start = performance.now();
      try {
        const res = await callUpstream(cfg.upstream, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 'metrics-' + idKey }, UPSTREAM_TIMEOUT_MS);
        const blockNumber = res.error ? null : hexToInt(res.result);
        const healthy = !res.error && blockNumber !== null;
        const error = res.error ? res.error.message : healthy ? null : 'malformed eth_blockNumber response';
        const latencyMs = Math.round(performance.now() - start);
        return { chainId: Number(idKey), name: cfg.name, healthy, blockNumber, latencyMs, error };
      } catch (e) {
        const latencyMs = Math.round(performance.now() - start);
        return { chainId: Number(idKey), name: cfg.name, healthy: false, blockNumber: null, latencyMs, error: 'unexpected metrics probe failure' };
      }
    })
  );
  const chains = results;
  const healthyChains = chains.filter(c => c.healthy).length;
  const base = chains.find((chain) => chain.chainId === 8453);
  const baseLatestBlock = base?.healthy ? base.blockNumber : null;
  return { supportedChains: SUPPORTED_CHAINS.length, healthyChains, baseLatestBlock, generatedAt: new Date().toISOString(), chains };
}

// Health and documentation endpoints.
// ---------------------------------------------------------------------------

function jsonHealthBody() {
  return {
    name: 'hookline',
    version: '0.1.0',
    status: 'live',
    mode: 'worker',
    transaction_submission_supported: false,
    chains: SUPPORTED_CHAINS.length,
    chainsSupported: SUPPORTED_CHAINS,
    documentationUrl: '/rpc',
    healthUrl: '/health',
    timestamp: Date.now(),
  };
}

const JSON_DOCS_CURL_EXAMPLE = (origin) =>
  `curl -sS ${origin}/rpc \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","method":"hookline_chains","params":[],"id":1}'`;

function jsonDocsBody(request) {
  const origin = new URL(request.url).origin;
  const chainRoutes = SUPPORTED_CHAINS.map((id) => `/rpc/${id}`);
  return {
    service: 'hookline',
    version: '0.1.0',
    status: 'live',
    mode: 'worker',
    transaction_submission_supported: false,
    origin: origin,
    routes: {
      rpcRoot: '/rpc',
      paidRpc: '/rpc/paid',
      metrics: '/metrics',
      health: '/health',
      documentation: '/rpc',
      chainProxies: chainRoutes,
    },
    methods: {
      hookline: [
        'hookline_chains',
        'hookline_decodePermissions',
        'hookline_chainStatus',
        'hookline_getHook',
      ],
      standardProxy: [...STANDARD_METHODS].sort(),
    },
    chains: Object.entries(CHAIN_CONFIG).map(([idKey, cfg]) => ({
      chainId: Number(idKey),
      chainIdHex: '0x' + Number(idKey).toString(16),
      name: cfg.name,
      code: cfg.code,
      upstream: cfg.upstream,
      route: `/rpc/${idKey}`,
      transaction_submission_supported: false,
    })),
    curlExample: JSON_DOCS_CURL_EXAMPLE(origin),
    paidAccess: {
      endpoint: '/rpc/paid',
      scheme: 'exact',
      network: X402_NETWORK,
      asset: X402_USDC_ASSET,
      amountAtomic: X402_AMOUNT_ATOMIC,
      priceUsd: '0.01',
      token: 'USDC',
      payTo: X402_PAY_TO,
      facilitator: 'https://facilitator.payai.network',
      rateLimit: 'paid requests bypass the public per-IP limit after verification',
    },
    constraints: {
      batchesSupported: false,
      maxBodyBytes: MAX_BODY_BYTES,
      maxUpstreamResponseBytes: MAX_UPSTREAM_RESPONSE_BYTES,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      bestEffortRequestsPerMinutePerIp: RATE_LIMIT_REQUESTS,
      transactionSubmissionSupported: false,
      upstreamUrlFromRequestSupported: false,
    },
    warnings: [
      'rate-limited and subject to change',
      'no transaction submission is supported',
      'JSON-RPC batches are rejected',
      'bodies over 32 KiB are rejected with a parse error',
      'upstream requests time out after 8 seconds',
      'responses carry no-store cache control',
    ],
  };
}

// ---------------------------------------------------------------------------
// Static asset serving.
// ---------------------------------------------------------------------------

function sendStaticAsset(path, type, content) {
  const headers = Object.assign(
    {
      'Content-Type': type,
      'Content-Length': String(new TextEncoder().encode(content).byteLength),
      'Cache-Control':
        path === '/'
          ? 'no-cache, must-revalidate'
          : 'public, max-age=300, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'false',
    },
    SECURITY_HEADERS
  );
  return new Response(content, { status: 200, headers });
}

function handleStaticAsset(path) {
  const route = STATIC_ROUTES[path];
  if (!route) return undefined;
  const content = ASSETS[route.key];
  if (content === undefined) {
    return undefined;
  }
  return sendStaticAsset(path, route.type, content);
}

function sendNotFound() {
  return new Response(
    JSON.stringify(
      makeRpcEnvelope('not-found', undefined, {
        code: -404,
        message:
          'not found: visit #observatory, #compare or #network',
      })
    ),
    { status: 404, headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }) }
  );
}

// ---------------------------------------------------------------------------
// Paid RPC access. Payment verification and settlement are delegated to the
// official x402 middleware and PayAI facilitator. The public routes above stay
// free and retain their best-effort per-IP rate limit.
// ---------------------------------------------------------------------------

let paidRpcApp;

function getPaidRpcApp() {
  if (paidRpcApp) return paidRpcApp;

  // Cloudflare Workers forbid network I/O during module initialization. Build
  // the x402 server on the first paid request so facilitator capability sync
  // runs inside a request handler, then reuse it for the isolate lifetime.
  const paidResourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient(payAiFacilitator)
  ).register(X402_NETWORK, new ExactEvmScheme());

  const app = new Hono();
  app.use(
    paymentMiddleware(
      {
        'POST /rpc/paid': {
          accepts: {
            scheme: 'exact',
            network: X402_NETWORK,
            payTo: X402_PAY_TO,
            price: {
              asset: X402_USDC_ASSET,
              amount: X402_AMOUNT_ATOMIC,
              extra: { name: 'USD Coin', version: '2' },
            },
            maxTimeoutSeconds: 300,
          },
          description: 'Higher-capacity Hookline JSON-RPC request',
          mimeType: 'application/json',
          serviceName: 'Hookline',
        },
      },
      paidResourceServer,
      undefined,
      undefined,
      true
    )
  );

  app.post('/rpc/paid', async (c) => {
    const parsed = await readJsonRpcBody(c.req.raw);
    if ('type' in parsed && parsed.type) {
      return sendRpcError(
        parsed.rawId !== undefined ? parsed.rawId : null,
        parsed.code,
        parsed.message
      );
    }
    return dispatchHooklineRpc(parsed, parsed.id, c.executionCtx);
  });

  paidRpcApp = app;
  return paidRpcApp;
}

function withPaidResponseHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Credentials', 'false');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.hostname === 'www.hookline.world') {
      url.protocol = 'https:';
      url.hostname = 'hookline.world';
      return Response.redirect(url.toString(), 301);
    }

    // CORS preflight.
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: makeCORSHeaders(),
      });
    }

    // Static assets.
    const staticResponse = handleStaticAsset(url.pathname);
    if (staticResponse) {
      return staticResponse;
    }

    // GET /metrics — machine-readable metrics.
    if (method === 'GET' && url.pathname === '/metrics') {
      return new Response(
        JSON.stringify(await jsonMetricsBody()),
        { headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }) }
      );
    }

    // GET /health — machine-readable status.
    if (method === 'GET' && url.pathname === '/health') {
      return new Response(
        JSON.stringify(jsonHealthBody()),
        { headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }) }
      );
    }

    // GET /rpc — human-readable documentation (origin derived from the request).
    if (method === 'GET' && url.pathname === '/rpc') {
      return new Response(
        JSON.stringify(jsonDocsBody(request)),
        { headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }) }
      );
    }

    // POST /rpc/paid — x402-protected Hookline methods. Parse a clone first so
    // malformed JSON-RPC never triggers a payment challenge or consumes a paid
    // request. The original body remains available to Hono after verification.
    if (method === 'POST' && url.pathname === '/rpc/paid') {
      const parsed = await readJsonRpcBody(request.clone());
      if ('type' in parsed && parsed.type) {
        return sendRpcError(
          parsed.rawId !== undefined ? parsed.rawId : null,
          parsed.code,
          parsed.message
        );
      }
      const paidResponse = await getPaidRpcApp().fetch(request, env, ctx);
      return withPaidResponseHeaders(paidResponse);
    }

    // POST /rpc — Hookline public methods (JSON-RPC 2.0).
    if (method === 'POST' && url.pathname === '/rpc') {
      const parsed = await readJsonRpcBody(request);
      if ('type' in parsed && parsed.type) {
        return sendRpcError(
          parsed.rawId !== undefined ? parsed.rawId : null,
          parsed.code,
          parsed.message
        );
      }
      const rl = checkRateLimit(getConnectingIp(request));
      if (rl.tooMany) {
        return sendRateLimitError(parsed.id, rl.retryAfter);
      }
      return dispatchHooklineRpc(parsed, parsed.id, ctx);
    }

    // POST /rpc/:chainId — standard public JSON-RPC proxy.
    const chainMatch = url.pathname.match(/^\/rpc\/([0-9]+)$/);
    if (chainMatch && method === 'POST') {
      const parsed = await readJsonRpcBody(request);
      if ('type' in parsed && parsed.type) {
        return sendRpcError(
          parsed.rawId !== undefined ? parsed.rawId : null,
          parsed.code,
          parsed.message
        );
      }
      const rl = checkRateLimit(getConnectingIp(request));
      if (rl.tooMany) {
        return sendRateLimitError(parsed.id, rl.retryAfter);
      }
      return proxyStandardRpc(
        Number(chainMatch[1]),
        parsed,
        parsed.id,
        ctx
      );
    }

    return sendNotFound();
  },
};
