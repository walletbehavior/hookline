/**
 * Hookline — Uniswap v4 Hook Evidence Observatory
 *
 * Static prototype: plain HTML/CSS/JS, no network calls, no build step.
 * All candidates, blocks, transactions, fingerprints and fee figures are
 * fictional demo data generated locally.
 */
(function () {
  'use strict';

  // ---------------- Configuration ----------------

  const CHAINS = Object.freeze({
    1:      { name: 'Ethereum',    code: 'ETH' },
    8453:   { name: 'Base',        code: 'BASE' },
    42161:  { name: 'Arbitrum One', code: 'ARB' },
    4663:   { name: 'Robinhood Chain', code: 'RHB' },
  });

  const SUPPORTED_CHAINS = Object.freeze([1, 8453, 42161, 4663]);

  const VIEW_OBS = 'observatory';
  const VIEW_CMP = 'compare';
  const VIEW_NET = 'network';

  // The 14 canonical Uniswap v4 hook permission flags, high bit -> low bit.
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

  const OWNER_SELECTOR = '0x8fa72e11';
  const MAX_CANDIDATES = 10;
  const WATCHLIST_KEY = 'hookline:watchlist:v1';

  // ---------------- Demo data (fictional) ----------------

  const DEMO_CANDIDATES = [
    {
      chainId: 1, label: 'ETH Beacon Hook',
      address: '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      latestBlock: 21345678,
      fingerprint: 'fp_eth_a1b2c3d4',
      probeOwner: '0x1111111111111111111111111111111111111111',
      observations: [
        { chainId: 1, block: 21345600, txHash: '0xd00d11112222333344445555666677778888999900001111222233334444555566667777', timestamp: Date.now() - 120000, fingerprint: 'fp_eth_a1b2c3d4', selectorHex: OWNER_SELECTOR, probeValue: '0x1111111111111111111111111111111111111111' },
        { chainId: 1, block: 21345640, txHash: '0xd00d22223333444455556666777788889999000011112222333344445555666677778888', timestamp: Date.now() - 60000, fingerprint: 'fp_eth_a1b2c3d4', selectorHex: OWNER_SELECTOR, probeValue: '0x1111111111111111111111111111111111111111' },
      ],
    },
    {
      chainId: 8453, label: 'Base TradeHook Alpha',
      address: '0x9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a01',
      latestBlock: 24567890,
      fingerprint: 'fp_base_shared',
      probeOwner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observations: [
        { chainId: 8453, block: 24567800, txHash: '0xd00d55556666777788889999000011112222333344445555666677778888999900001111', timestamp: Date.now() - 90000, fingerprint: 'fp_base_shared', selectorHex: OWNER_SELECTOR, probeValue: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      ],
    },
    {
      chainId: 8453, label: 'Base TradeHook Alpha (scan duplicate)',
      address: '0x9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a02',
      latestBlock: 24567890,
      fingerprint: 'fp_base_shared',
      probeOwner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      observations: [],
    },
    {
      chainId: 42161, label: 'ARB Liquidity Hook',
      address: '0xfeed000000000000000000000000000000000001',
      latestBlock: 224567890,
      fingerprint: 'fp_arb_c5d6e7f8',
      probeOwner: '0x2222222222222222222222222222222222222222',
      observations: [
        { chainId: 42161, block: 224567800, txHash: '0xd00d99990000111122223333444455556666777788889999000011112222333344445555', timestamp: Date.now() - 200000, fingerprint: 'fp_arb_c5d6e7f8', selectorHex: OWNER_SELECTOR, probeValue: '0x2222222222222222222222222222222222222222' },
      ],
    },
    {
      chainId: 4663, label: 'RHB Vault Hook',
      address: '0x1237000000000000000000000000000000000001',
      latestBlock: 1567890,
      fingerprint: 'fp_rhb_d9e0f1a2',
      probeOwner: '0x3333333333333333333333333333333333333333',
      observations: [
        { chainId: 4663, block: 1567800, txHash: '0xd00d33334444555566667777888899990000111122223333444455556666777788889999', timestamp: Date.now() - 180000, fingerprint: 'fp_rhb_d9e0f1a2', selectorHex: OWNER_SELECTOR, probeValue: '0x3333333333333333333333333333333333333333' },
        { chainId: 4663, block: 1567860, txHash: '0xd00d44445555666677778888999900001111222233334444555566667777888899990000', timestamp: Date.now() - 60000, fingerprint: 'fp_rhb_d9e0f1a2', selectorHex: OWNER_SELECTOR, probeValue: '0x3333333333333333333333333333333333333333' },
      ],
    },
    {
      chainId: 1, label: 'ETH Swap Hook B',
      address: '0xb00b1234567890abcdef1234567890abcdef1234',
      latestBlock: 21345000,
      fingerprint: 'fp_eth_b3c4d5e6',
      probeOwner: '0x4444444444444444444444444444444444444444',
      observations: [],
    },
  ];

  // ---------------- DOM cache ----------------

  const $ = (id) => document.getElementById(id);
  const $L = (s) => document.querySelectorAll(s);

  // ---------------- State ----------------

  const state = {
    watchlist: [],
    selectedKey: null,
    compareLeft: null,
    compareRight: null,
    toastTimer: null,
  };

  // ---------------- Core helpers ----------------

  // HTML-escape a user-supplied string before it enters the DOM.
  function esc(s) {
    if (s == null) return '';
    const str = String(s);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function candidateKey(c) {
    return `${String(c.chainId)}:${String(c.address).toLowerCase()}`;
  }

  // ---- storage ----
  function getWatchlist() {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveWatchlist(wl) {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(wl));
    } catch (e) {
      // localStorage unavailable (private mode, quota); keep in-memory only.
      console.warn('[hookline] localStorage write failed:', e);
    }
  }

  function seedDemoData() {
    let wl = getWatchlist();
    if (!Array.isArray(wl) || !wl.length) {
      wl = [...DEMO_CANDIDATES];
      saveWatchlist(wl);
    }
    return wl;
  }

  // ---- validation (mirrors the UI) ----
  function validateAddress(raw) {
    const addr = String(raw || '').toLowerCase().trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return { ok: false, msg: 'Address must be 0x followed by exactly 40 hexadecimal characters.' };
    }
    return { ok: true, addr };
  }

  function validateChainId(cid) {
    if (!Number.isInteger(cid) || !SUPPORTED_CHAINS.includes(cid)) {
      return { ok: false, msg: 'Unsupported chain.' };
    }
    return { ok: true };
  }

  // ---- permission decoding: low 14 address bits, high->low flag order ----
  function decodePermissions(address) {
    const addr = String(address).toLowerCase();
    // Use BigInt on the full address so large hex addresses never lose precision;
    // mask with 0x3fffn (all 14 low bits), then convert the masked value to Number.
    const masked = BigInt(addr) & 0x3fffn;
    const value = Number(masked);
    const flags = PERMISSION_FLAGS.map((name, i) => ({
      name,
      bit: 13 - i,                 // bit position within the 14-bit value
      enabled: !!(value & (1 << (13 - i))),
    }));
    return { value, flags };
  }

  // Deterministic demo fields for candidates added via WebMCP only.
  function fnv32(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function computeDemoFields(address) {
    const h = fnv32(String(address));
    const h2 = Math.imul(h, 0x9e3779b9) >>> 0;
    return {
      fingerprint: 'fp_' + (h >>> 0).toString(16).padStart(8, '0'),
      latestBlock: 20000000 + (h % 5000000),
      probeOwner: '0x' + (h2 >>> 0).toString(16).padStart(40, '0'),
    };
  }

  // ---- candidate add (validates, dedupes, enforces 10) ----
  function addCandidateInternal(raw, label) {
    const cidCheck = validateChainId(raw.chainId);
    if (!cidCheck.ok) throw new Error(cidCheck.msg);
    const addrCheck = validateAddress(raw.address);
    if (!addrCheck.ok) throw new Error(addrCheck.msg);
    const addr = addrCheck.addr;

    if (state.watchlist.some((c) => candidateKey(c) === `${raw.chainId}:${addr}`)) {
      throw new Error('Duplicate candidate: already in watchlist.');
    }
    if (state.watchlist.length >= MAX_CANDIDATES) {
      throw new Error('Watchlist full: maximum 10 candidates allowed.');
    }

    const entry = {
      chainId: raw.chainId,
      address: addr,
      addedAt: Date.now(),
    };
    if (label) {
      const lbl = String(label).trim();
      if (lbl) entry.label = lbl;
    }
    Object.assign(entry, computeDemoFields(addr));
    state.watchlist.push(entry);
    saveWatchlist(state.watchlist);

    // UI and WebMCP additions must appear immediately once the DOM is initialized.
    if (document.readyState !== 'loading') {
      renderWatchlist();
      populateCompareSelects();
    }
    return entry;
  }

  // ---------------- Rendering helpers ----------------

  function renderWatchlist() {
    const filter = $('chain-filter').value;
    const list = $('watchlist-items');
    const items = state.watchlist.filter((c) => {
      if (filter === 'all') return true;
      return String(c.chainId) === filter;
    });

    const html = items.map((c) => {
      const fp = (c.fingerprint || '').slice(0, 12);
      const short = `${c.address.slice(0, 6)}…${c.address.slice(-5)}`;
      const selected = c === getSelected();
      const label = esc(c.label || `${CHAINS[c.chainId].name} hook`);
      return `<li class="watch-item${selected ? ' selected' : ''}"
                  data-key="${candidateKey(c)}"
                  role="button"
                  tabindex="0"
                  aria-label="${label} on ${CHAINS[c.chainId].name}"
                  aria-pressed="${selected ? 'true' : 'false'}">
        <div class="watch-item-body">
          <span class="watch-item-label">${label}</span>
          <span class="watch-item-address">${esc(short)}</span>
          <span class="watch-item-fp">${esc(fp)}</span>
        </div>
        <button class="watch-item-unfollow"
                type="button"
                aria-label="Unfollow ${label}"
                title="Unfollow">
          unfollow
        </button>
      </li>`;
    }).join('');

    list.innerHTML = html || '<li class="empty-state">No candidates match this chain.</li>';
    $('watchlist-count').textContent = items.length;

    // restore selection styling after re-render
    highlightSelection();
  }

  function getSelected() {
    return state.watchlist.find((c) => candidateKey(c) === state.selectedKey);
  }

  function highlightSelection() {
    const items = $L('.watch-item');
    items.forEach((li) => {
      li.classList.toggle('selected', li.dataset.key === state.selectedKey);
      li.setAttribute('aria-pressed', li.dataset.key === state.selectedKey ? 'true' : 'false');
    });
  }

  function renderSelected(c) {
    const detail = $('candidate-detail');
    const empty = $('selection-empty');
    detail.hidden = false;
    empty.hidden = true;
    $('detail-label').textContent = c.label || `${CHAINS[c.chainId].name} hook`;
    $('detail-chain').textContent = `${CHAINS[c.chainId].name} (${c.chainId})`;
    $('detail-address').textContent = c.address;
    $('detail-block').textContent = String(c.latestBlock || '—');
    $('detail-fp').textContent = c.fingerprint || '—';
    $('detail-owner').textContent = c.probeOwner || '—';

    const perm = decodePermissions(c.address);
    const permHtml = perm.flags
      .map(
        (f) => `<div class="flag" role="checkbox"
                       aria-checked="${f.enabled}"
                       aria-pressed="${f.enabled}"
                       tabindex="0">
                  <span class="flag-name">${esc(f.name)}</span>
                  <span class="flag-val">${f.enabled ? 'enabled' : 'disabled'}</span>
                </div>`
      )
      .join('');
    $('perm-grid').innerHTML = permHtml;
    $('perm-note').textContent =
      `Decoded from the low 14 bits of the address (${perm.value.toString(16)}, ${perm.flags.filter((f) => f.enabled).length} of ${PERMISSION_FLAGS.length} set) in the canonical bit order: beforeInitialize → afterRemoveLiquidityReturnDelta.`;
  }

  function renderEvidence(c) {
    const section = $('evidence-section');
    const list = $('evidence-timeline');
    const entries = (c.observations || []).slice().reverse();

    if (entries.length) {
      section.hidden = false;
      list.innerHTML = entries
        .map((e, i) => {
          const date = new Date(e.timestamp);
          return `<li class="evidence-entry"
                      data-key="${candidateKey(c)}"
                      data-block="${esc(String(e.block))}"
                      tabindex="0">
            <div class="ee-top">
              <span class="chain-badge">${esc(CHAINS[e.chainId].name)}</span>
              <span class="block">block <code>${esc(String(e.block))}</code></span>
              <span class="tx">tx <code>${esc(e.txHash.slice(0, 18) + '…')}</code></span>
              <span class="time">${esc(date.toLocaleString())}</span>
            </div>
            <div class="ee-row">
              <span class="label">runtime fingerprint</span>
              <code>${esc(e.fingerprint || '—')}</code>
            </div>
            <div class="ee-row">
              <span class="label">owner() selector</span>
              <code>${esc(e.selectorHex || OWNER_SELECTOR)} = ${esc(e.probeValue || '—')}</code>
            </div>
          </li>`;
        })
        .join('');
    } else {
      section.hidden = true;
      list.innerHTML = '';
    }
  }

  function renderCompareResult(result) {
    const el = $('compare-results');
    if (!result.ok) {
      const chainL = CHAINS[result.left.chainId].name;
      const chainR = CHAINS[result.right.chainId].name;
      el.innerHTML = `
        <div class="comp-refusal" role="alert">
          <p class="refusal-title">Comparison refused — different chains</p>
          <p><strong>${esc(chainL)}</strong> vs <strong>${esc(chainR)}</strong>: evidence and block heights are not comparable across chains, so no authoritative comparison can be shown.</p>
          ${result.codeFamilyHint
            ? `<p class="hint">Non-authoritative code-family hint: both candidates share the runtime bytecode fingerprint "${esc(result.codeFamilyHint)}" — treat it as a possible clone-scan artifact, not proof of identity.</p>`
            : `<p class="hint">No non-authoritative code-family hint is available for this cross-chain pair.</p>`}
        </div>`;
      return;
    }

    const { left, right } = result;
    const blockDelta = right.latestBlock - left.latestBlock;
    const fpMatch = left.fingerprint === right.fingerprint;
    const ownerMatch = left.probeOwner === right.probeOwner;

    const deltaRows = PERMISSION_FLAGS.map((name, i) => {
      const va = !!(left.value & (1 << (13 - i)));
      const vb = !!(right.value & (1 << (13 - i)));
      const same = va === vb;
      const ac = va ? 'enabled' : '';
      const bc = vb ? 'enabled' : '';
      const dc = same ? 'same' : 'diff';
      return `
        <div class="row row-flag">
          <div class="cell ${ac}">${esc(name)}</div>
          <div class="cell ${ac}">${va ? '1' : '0'}</div>
          <div class="cell ${bc}">${vb ? '1' : '0'}</div>
          <div class="cell ${dc}">${same ? 'same' : 'diff'}</div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <h3>Comparison: ${esc(left.label)} vs ${esc(right.label)}</h3>
      <div class="comp-ok">
        <div class="comp-row">
          <span class="label">chain</span>
          <span class="ok">${esc(CHAINS[left.chainId].name)} (both)</span>
        </div>
        <div class="comp-row">
          <span class="label">latest block</span>
          <code>${esc(String(left.latestBlock))}</code> vs <code>${esc(String(right.latestBlock))}</code>
          <span class="${blockDelta === 0 ? 'ok' : 'bad'}" aria-label="block delta">${esc(blockDelta >= 0 ? '+' : '')}${esc(String(blockDelta))}</span>
        </div>
        <div class="comp-row">
          <span class="label">runtime fingerprint</span>
          ${fpMatch ? '<span class="ok">match</span>' : '<span class="bad">mismatch</span>'}
          <code>${esc(left.fingerprint)} ${fpMatch ? '==' : '≠'} ${esc(right.fingerprint)}</code>
        </div>
        <div class="comp-row">
          <span class="label">owner() selector probe</span>
          <code>${esc(left.probeOwner)}</code> vs <code>${esc(right.probeOwner)}</code>
          <span class="${ownerMatch ? 'ok' : 'bad'}" aria-label="owner probe match">${ownerMatch ? 'same' : 'differs'}</span>
        </div>
        <div class="comp-row">
          <span class="label">selector-probe differences</span>
          <span class="${ownerMatch ? 'ok' : 'bad'}">${ownerMatch ? 'none' : 'owner() differs'}</span>
        </div>
        <div class="perm-delta">
          <div class="cell row-header">flag</div>
          <div class="cell row-header a">left</div>
          <div class="cell row-header b">right</div>
          <div class="cell row-header d">Δ</div>
          ${deltaRows}
        </div>
      </div>`;
  }

  function renderFee(marketCap, vm) {
    const volume = marketCap * vm;
    const fees = volume * 0.008;
    $('fee-result').innerHTML = `
      <strong>Estimated launcher fees: $${fmtNumber(fees)} USD-equivalent</strong>
      <br><span class="mono" style="font-size:0.813rem;color:var(--bone-dim)">
        ${fmtNumber(marketCap)} market cap × ${esc(String(vm))}x volume = ${fmtNumber(volume)} trading volume × 0.008 (1% total fee × 80% launcher share)
      </span>
      <br><span class="mono" style="font-size:0.813rem;color:var(--bone-dim)">
        Estimate only. Payout, if any, would be in ETH per current Flaunchy venue documentation.
      </span>`;
  }

  function fmtNumber(n) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // ---------------- Actions ----------------

  function selectCandidate(key) {
    const c = state.watchlist.find((x) => candidateKey(x) === key);
    if (!c) return;
    state.selectedKey = key;
    renderWatchlist();
    renderSelected(c);
    renderEvidence(c);
    toast(`Selected ${esc(c.label || c.address)}`, 'ok');
  }

  function simulateObservation(c) {
    const chainBase = { 1: 21340000, 8453: 24500000, 42161: 224500000, 4663: 1500000 };
    const base = c.latestBlock || chainBase[c.chainId] || 0;
    const nextBlock = base + Math.floor(Math.random() * 900) + 100;
    const suffix = Math.random().toString(16).slice(2, 14).padEnd(14, '0');

    const entry = {
      chainId: c.chainId,
      block: nextBlock,
      txHash: `0x${'deadbeef'.repeat(2)}${suffix}`,
      timestamp: Date.now(),
      fingerprint: c.fingerprint || 'fp_unknown',
      selectorHex: OWNER_SELECTOR,
      probeValue: c.probeOwner || '0x0000000000000000000000000000000000000000',
    };

    if (!c.observations) c.observations = [];
    c.observations.push(entry);
    c.latestBlock = nextBlock;
    saveWatchlist(state.watchlist);

    renderSelected(c);
    renderEvidence(c);
    toast(`Simulated observation appended: block ${nextBlock} (${CHAINS[c.chainId].name})`, 'ok');
  }

  function unfollow(c) {
    const idx = state.watchlist.findIndex((x) => candidateKey(x) === candidateKey(c));
    if (idx === -1) return;
    state.watchlist.splice(idx, 1);
    saveWatchlist(state.watchlist);
    if (state.selectedKey === candidateKey(c)) {
      state.selectedKey = null;
      $('candidate-detail').hidden = true;
      $('selection-empty').hidden = false;
      $('evidence-section').hidden = true;
    }
    renderWatchlist();
    toast(`Unfollowed ${esc(c.label || c.address)}`, 'ok');
  }

  function handleAddCandidate(e) {
    e.preventDefault();
    const form = e.target;
    const chain = Number(form['add-chain'].value);
    const addr = form['add-address'].value;
    const label = form['add-label'].value;

    const errEl = $('add-form-error');
    errEl.textContent = '';

    try {
      const added = addCandidateInternal({ chainId: chain, address: addr }, label);
      form.reset();
      selectCandidate(candidateKey(added));
    } catch (err) {
      errEl.textContent = err.message;
      toast(err.message, 'alert');
    }
  }

  function handleWatchlistClick(e) {
    const item = e.target.closest('.watch-item');
    if (!item) return;

    if (e.target.classList.contains('watch-item-unfollow')) {
      e.preventDefault();
      e.stopPropagation();
      unfollow(state.watchlist.find((c) => candidateKey(c) === item.dataset.key));
      return;
    }

    selectCandidate(item.dataset.key);
  }

  function handleWatchlistKeydown(e) {
    const item = e.target.closest('.watch-item');
    if (!item) return;
    // Key events from the nested unfollow button are ignored (clicks are handled separately).
    if (e.target.classList.contains('watch-item-unfollow')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectCandidate(item.dataset.key);
    }
  }

  function handleDetailClick(e) {
    const target = e.target;
    if (target.id === 'simulate-btn') {
      const c = getSelected();
      if (!c) return;
      simulateObservation(c);
    } else if (target.id === 'unfollow-btn') {
      const c = getSelected();
      if (!c) return;
      unfollow(c);
    }
  }

  function handleCompareSubmit(e) {
    e.preventDefault();
    const left = state.watchlist.find((c) => candidateKey(c) === $('comp-left').value);
    const right = state.watchlist.find((c) => candidateKey(c) === $('comp-right').value);

    if (!left || !right) {
      toast('Select both candidates to compare.', 'alert');
      return;
    }

    state.compareLeft = candidateKey(left);
    state.compareRight = candidateKey(right);
    renderCompareResult(compareCandidates(left, right));
  }

  function compareCandidates(left, right) {
    if (left.chainId !== right.chainId) {
      return {
        ok: false,
        left,
        right,
        codeFamilyHint: left.fingerprint === right.fingerprint ? left.fingerprint : null,
      };
    }

    const leftPerm = decodePermissions(left.address);
    const rightPerm = decodePermissions(right.address);
    const blockDelta = right.latestBlock - left.latestBlock;
    const fpMatch = left.fingerprint === right.fingerprint;
    const ownerMatch = left.probeOwner === right.probeOwner;

    return {
      ok: true,
      left: Object.assign({}, left, leftPerm),
      right: Object.assign({}, right, rightPerm),
      blockDelta,
      fpMatch,
      ownerMatch,
    };
  }

  function populateCompareSelects() {
    const left = $('comp-left');
    const right = $('comp-right');
    const opts = state.watchlist
      .map((c) => `<option value="${candidateKey(c)}">${esc(CHAINS[c.chainId].name)} — ${esc(c.label || c.address.slice(0, 8) + '…')}</option>`)
      .join('');
    left.innerHTML = opts;
    right.innerHTML = opts;

    if (state.watchlist.length >= 2) {
      left.value = candidateKey(state.watchlist[0]);
      right.value = candidateKey(state.watchlist[1]);
    } else if (state.watchlist.length === 1) {
      left.value = candidateKey(state.watchlist[0]);
    }
  }

  // ---------------- Navigation & UI feedback ----------------

  function setView(view) {
    state.currentView = view;
    $L('[data-view]').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === view);
      a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
    });
    $L('.view').forEach((el) => {
      el.classList.toggle('active', el.id === `view-${view}`);
    });
    if (view === VIEW_CMP) {
      populateCompareSelects();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function loadViewFromHash() {
    const h = (window.location.hash || '#observatory').slice(1);
    if (h === VIEW_OBS || h === VIEW_CMP || h === VIEW_NET) return h;
    return VIEW_OBS;
  }

  function toast(message, kind = 'info') {
    const el = $('hookline-toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast' + (kind ? ` ${kind}` : '');
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 4000);
  }

  // ---------------- WebMCP tool registration (imperative, behind feature detection) ----------------

  function registerWebMCPTools() {
    if (typeof document?.modelContext?.registerTool !== 'function') {
      return;
    }

    const tools = [
      {
        name: 'decode_hook_address',
        description: 'Read-only. Decode the 14-bit Uniswap v4 hook permission flags embedded in an address and return the candidate identity plus all permission flags.',
        inputSchema: {
          type: 'object',
          required: ['chainId', 'address'],
          additionalProperties: false,
          properties: {
            chainId: {
              type: 'integer',
              enum: SUPPORTED_CHAINS,
              description: 'Chain ID of the candidate (1, 8453, 42161, or 4663)',
            },
            address: {
              type: 'string',
              pattern: '^0x[0-9a-fA-F]{40}$',
              description: '40-hex contract address',
            },
          },
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ chainId, address }) => {
          const cidCheck = validateChainId(chainId);
          if (!cidCheck.ok) throw new Error(`Unsupported chain: ${chainId}`);
          const addr = String(address).toLowerCase();
          if (!/^[0-9a-fA-F]{40}$/.test(addr.slice(2))) {
            throw new Error('Address must be 0x followed by 40 hexadecimal characters');
          }
          const perm = decodePermissions(addr);
          return {
            identity: {
              chainId,
              chainName: CHAINS[chainId].name,
              address: addr,
              addressBits: perm.value,
            },
            permissions: perm.flags.map((f) => ({ flag: f.name, enabled: f.enabled, bit: f.bit })),
          };
        },
      },
      {
        name: 'add_watch_candidate',
        description: 'Destructive. Add a candidate to the local watchlist using the same validation and 10-candidate limit as the UI.',
        inputSchema: {
          type: 'object',
          required: ['chainId', 'address'],
          additionalProperties: false,
          properties: {
            chainId: {
              type: 'integer',
              enum: SUPPORTED_CHAINS,
              description: 'Chain ID of the candidate',
            },
            address: {
              type: 'string',
              pattern: '^0x[0-9a-fA-F]{40}$',
              description: '40-hex contract address',
            },
            label: {
              type: 'string',
              description: 'Optional human-readable label',
            },
          },
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async ({ chainId, address, label }) => {
          return addCandidateInternal({ chainId, address }, label);
        },
      },
      {
        name: 'compare_candidates',
        description: 'Read-only. Compare two watchlisted candidates by key; returns a cross-chain refusal when the chain IDs differ.',
        inputSchema: {
          type: 'object',
          required: ['leftKey', 'rightKey'],
          additionalProperties: false,
          properties: {
            leftKey: {
              type: 'string',
              pattern: '^[0-9]+:0x[0-9a-fA-F]{40}$',
              description: 'Left candidate key, CHAIN_ID:ADDRESS',
            },
            rightKey: {
              type: 'string',
              pattern: '^[0-9]+:0x[0-9a-fA-F]{40}$',
              description: 'Right candidate key, CHAIN_ID:ADDRESS',
            },
          },
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ leftKey, rightKey }) => {
          const left = state.watchlist.find((c) => candidateKey(c) === leftKey);
          const right = state.watchlist.find((c) => candidateKey(c) === rightKey);
          if (!left) throw new Error(`Left candidate not found: ${leftKey}`);
          if (!right) throw new Error(`Right candidate not found: ${rightKey}`);
          return compareCandidates(left, right);
        },
      },
    ];

    tools.forEach((tool) => {
      try {
        document.modelContext.registerTool(tool);
      } catch (err) {
        console.warn('[hookline] WebMCP tool registration failed:', tool.name, err);
      }
    });
  }

  // ---------------- Network (fee estimator) actions ----------------

  function handleFeeSeed(e) {
    const btn = e.currentTarget;
    if (btn.dataset.mc != null) {
      $('fee-mc').value = btn.dataset.mc;
    } else if (btn.dataset.vm != null) {
      $('fee-vm').value = btn.dataset.vm;
    }
    handleFeeSubmit(e);
  }

  function handleFeeSubmit(e) {
    if (e) e.preventDefault();
    const mc = Number($('fee-mc').value) || 0;
    const vm = Number($('fee-vm').value) || 1;
    renderFee(mc, vm);
  }

  // ---------------- Public API (for inspection) ----------------

  window.Hookline = {
    getState: () => ({
      watchlist: state.watchlist.map((c) => ({
        chainId: c.chainId,
        address: c.address,
        label: c.label,
        fingerprint: c.fingerprint,
        probeOwner: c.probeOwner,
        observationsCount: (c.observations || []).length,
      })),
      selectedKey: state.selectedKey,
      compareKeys: [state.compareLeft, state.compareRight],
    }),
    decodePermissions,
    validateAddress,
    addCandidateInternal,
    compareCandidates,
  };

  // ---------------- Initialization ----------------

  function init() {
    state.watchlist = seedDemoData();
    state.selectedKey = null;
    state.compareLeft = null;
    state.compareRight = null;

    const view = loadViewFromHash();
    setView(view);

    renderWatchlist();
    populateCompareSelects();
    handleFeeSubmit(null);

    setupEvents();
    registerWebMCPTools();

    const hasWebmcp = typeof document?.modelContext?.registerTool === 'function';
    toast(
      `Hookline prototype loaded. ${hasWebmcp ? 'WebMCP tools registered.' : 'WebMCP unavailable (fetched without a context server).'} All data is fictional demo data.`
    );
  }

  function setupEvents() {
    // View navigation
    $L('[data-view]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.hash = a.dataset.view;
      });
    });
    window.addEventListener('hashchange', () => setView(loadViewFromHash()));

    // Chain filter
    $('chain-filter').addEventListener('change', renderWatchlist);

    // Add candidate form
    $('add-candidate-form').addEventListener('submit', handleAddCandidate);

    // Watchlist interactions (delegation)
    const items = $('watchlist-items');
    items.addEventListener('click', handleWatchlistClick);
    items.addEventListener('keydown', handleWatchlistKeydown);

    // Selected candidate actions
    const detail = $('candidate-detail');
    detail.addEventListener('click', handleDetailClick);

    // Compare
    $('compare-form').addEventListener('submit', handleCompareSubmit);

    // Fee estimator
    $('fee-form').addEventListener('submit', handleFeeSubmit);
    $L('.fee-seed').forEach((btn) => {
      btn.addEventListener('click', handleFeeSeed);
    });
  }

  // Boot when the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
