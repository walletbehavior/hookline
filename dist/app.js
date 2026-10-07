/** Hookline multichain hooks analytics desk. Vanilla browser runtime. */
(function () {
  'use strict';

  const CHAINS = Object.freeze({
    1: { name: 'Ethereum', code: 'ETH' },
    8453: { name: 'Base', code: 'BASE' },
    42161: { name: 'Arbitrum One', code: 'ARB' },
    4663: { name: 'Robinhood Chain', code: 'RHB' },
  });
  const SUPPORTED_CHAINS = Object.freeze([1, 8453, 42161, 4663]);
  const PERMISSION_FLAGS = Object.freeze([
    'beforeInitialize', 'afterInitialize', 'beforeAddLiquidity', 'afterAddLiquidity',
    'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeSwap', 'afterSwap',
    'beforeDonate', 'afterDonate', 'beforeSwapReturnDelta', 'afterSwapReturnDelta',
    'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta',
  ]);
  const TOKEN_CA = '0x11672C8cD5CB3F17364339244826B110Bac0AC91';
  const WATCHLISTS_KEY = 'hookline:watchlists:v3';
  const WATCHLISTS_V2_KEY = 'hookline:watchlist:v2';
  const MAX_LISTS = 20;
  const MAX_ITEMS_PER_LIST = 100;
  const MAX_OBSERVATIONS = 100;
  const MAX_IMPORT_BYTES = 1024 * 1024;
  const CURRENT_WINDOW_MS = 15 * 60 * 1000;
  const VIEWS = new Set(['observatory', 'watchlists', 'network', 'docs']);

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const state = {
    model: null,
    selectedId: null,
    inspected: null,
    inspectionsThisSession: 0,
    metrics: null,
    healthOk: null,
    toastTimer: null,
    refreshing: false,
  };

  function makeId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return prefix + '-' + globalThis.crypto.randomUUID();
    }
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function cleanString(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString() : 'unavailable';
  }

  function formatLatency(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString() + ' ms' : 'unavailable';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'unavailable';
  }

  function relativeTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
  }

  function shorten(value, head, tail) {
    const text = String(value || '');
    const first = head || 7;
    const last = tail || 5;
    return text.length > first + last ? text.slice(0, first) + '…' + text.slice(-last) : text;
  }

  function validateAddress(raw) {
    const address = String(raw || '').trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(address)
      ? { ok: true, address }
      : { ok: false, message: 'Enter a 0x-prefixed address with exactly 40 hexadecimal characters.' };
  }

  function validateChainId(raw) {
    const chainId = Number(raw);
    return Number.isInteger(chainId) && SUPPORTED_CHAINS.includes(chainId)
      ? { ok: true, chainId }
      : { ok: false, message: 'Choose a supported chain.' };
  }

  function decodePermissions(address) {
    const value = Number(BigInt(address) & 0x3fffn);
    return {
      value,
      flags: PERMISSION_FLAGS.map((name, index) => ({
        name,
        bit: 13 - index,
        enabled: Boolean(value & (1 << (13 - index))),
      })),
    };
  }

  function candidateKey(candidate) {
    return String(candidate.chainId) + ':' + String(candidate.address).toLowerCase();
  }

  function fingerprintOf(evidence) {
    const fingerprint = evidence && evidence.runtimeFingerprint;
    if (fingerprint && typeof fingerprint === 'object') return cleanString(fingerprint.fingerprint, 128);
    return cleanString(fingerprint, 128);
  }

  function blankModel() {
    const id = makeId('list');
    return { version: 3, activeListId: id, lists: [{ id, name: 'Primary', createdAt: Date.now(), items: [] }] };
  }

  function normalizePermissions(raw, address) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.flags)) return decodePermissions(address);
    const byName = new Map(raw.flags.map((flag) => [flag && flag.name, flag]));
    const fallback = decodePermissions(address);
    return {
      value: Number.isFinite(Number(raw.value)) ? Number(raw.value) : fallback.value,
      flags: PERMISSION_FLAGS.map((name, index) => {
        const flag = byName.get(name);
        return { name, bit: 13 - index, enabled: flag ? Boolean(flag.enabled) : fallback.flags[index].enabled };
      }),
    };
  }

  function normalizeEvidence(raw, chainId, address) {
    if (!raw || typeof raw !== 'object') return null;
    const codeByteLength = Number(raw.codeByteLength);
    const latencyMs = Number(raw.latencyMs);
    const ownerCheck = validateAddress(raw.owner);
    const fingerprint = fingerprintOf(raw);
    return {
      chainId,
      chainIdHex: cleanString(raw.chainIdHex, 24),
      name: cleanString(raw.name, 80) || CHAINS[chainId].name,
      address,
      upstream: cleanString(raw.upstream, 240),
      codeByteLength: Number.isFinite(codeByteLength) && codeByteLength >= 0 ? codeByteLength : null,
      runtimeFingerprint: fingerprint ? { algorithm: 'SHA-256', fingerprint } : null,
      owner: ownerCheck.ok ? ownerCheck.address : null,
      ownerProbeStatus: cleanString(raw.ownerProbeStatus, 80),
      ownerProbeError: cleanString(raw.ownerProbeError, 300) || null,
      permissions: normalizePermissions(raw.permissions, address),
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,
    };
  }

  function normalizeObservation(raw, chainId, address) {
    if (!raw || typeof raw !== 'object') return null;
    const observedAt = Number(raw.observedAt != null ? raw.observedAt : raw.timestamp);
    const block = Number(raw.block != null ? raw.block : raw.latestBlock);
    const codeByteLength = Number(raw.codeByteLength);
    const latencyMs = Number(raw.latencyMs);
    const ownerCheck = validateAddress(raw.owner || raw.probeOwner);
    const fingerprint = fingerprintOf(raw) || cleanString(raw.fingerprint, 128);
    return {
      observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
      chainId,
      address,
      block: Number.isSafeInteger(block) && block >= 0 ? block : null,
      codeByteLength: Number.isFinite(codeByteLength) && codeByteLength >= 0 ? codeByteLength : null,
      runtimeFingerprint: fingerprint ? { algorithm: 'SHA-256', fingerprint } : null,
      owner: ownerCheck.ok ? ownerCheck.address : null,
      ownerProbeStatus: cleanString(raw.ownerProbeStatus, 80),
      ownerProbeError: cleanString(raw.ownerProbeError, 300) || null,
      permissions: normalizePermissions(raw.permissions, address),
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,
    };
  }

  function normalizeItem(raw, strict) {
    if (!raw || typeof raw !== 'object') {
      if (strict) throw new Error('Every imported item must be an object.');
      return null;
    }
    const chain = validateChainId(raw.chainId);
    const address = validateAddress(raw.address);
    if (!chain.ok || !address.ok) {
      if (strict) throw new Error('An imported item has an unsupported chain or invalid address.');
      return null;
    }
    let evidence = normalizeEvidence(raw.evidence, chain.chainId, address.address);
    if (!evidence && (raw.codeByteLength != null || raw.runtimeFingerprint || raw.permissions)) {
      evidence = normalizeEvidence(raw, chain.chainId, address.address);
    }
    const observations = Array.isArray(raw.observations)
      ? raw.observations.map((value) => normalizeObservation(value, chain.chainId, address.address)).filter(Boolean).slice(-MAX_OBSERVATIONS)
      : [];
    return {
      id: cleanString(raw.id, 120) || makeId('contract'),
      chainId: chain.chainId,
      address: address.address,
      label: cleanString(raw.label, 80) || null,
      evidence,
      observations,
      lastError: cleanString(raw.lastError, 300) || null,
      lastAttemptAt: Number.isFinite(Number(raw.lastAttemptAt)) ? Number(raw.lastAttemptAt) : null,
    };
  }

  function normalizeList(raw, strict, index) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
      if (strict) throw new Error('Every imported list must include an items array.');
      return null;
    }
    if (raw.items.length > MAX_ITEMS_PER_LIST) throw new Error('A list exceeds the 100-contract limit.');
    const deduped = [];
    const keys = new Set();
    raw.items.forEach((item) => {
      const normalized = normalizeItem(item, strict);
      if (!normalized) return;
      const key = candidateKey(normalized);
      if (!keys.has(key)) {
        keys.add(key);
        deduped.push(normalized);
      }
    });
    return {
      id: cleanString(raw.id, 120) || makeId('list'),
      name: cleanString(raw.name, 60) || 'Imported ' + (index + 1),
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
      items: deduped,
    };
  }

  function normalizeModel(raw, strict) {
    if (!raw || typeof raw !== 'object' || raw.version !== 3 || !Array.isArray(raw.lists)) {
      if (strict) throw new Error('Import must use the Hookline watchlists v3 format.');
      return null;
    }
    if (!raw.lists.length || raw.lists.length > MAX_LISTS) {
      if (strict) throw new Error('Import must contain between 1 and 20 lists.');
      return null;
    }
    const lists = raw.lists.map((list, index) => normalizeList(list, strict, index)).filter(Boolean);
    if (!lists.length) return null;
    const active = lists.some((list) => list.id === raw.activeListId) ? raw.activeListId : lists[0].id;
    return { version: 3, activeListId: active, lists };
  }

  function migrateV2() {
    try {
      const parsed = JSON.parse(localStorage.getItem(WATCHLISTS_V2_KEY) || 'null');
      if (!Array.isArray(parsed) || !parsed.length) return null;
      const id = makeId('list');
      const items = [];
      const keys = new Set();
      parsed.slice(0, MAX_ITEMS_PER_LIST).forEach((raw) => {
        const item = normalizeItem(raw, false);
        if (item && !keys.has(candidateKey(item))) {
          keys.add(candidateKey(item));
          items.push(item);
        }
      });
      return { version: 3, activeListId: id, lists: [{ id, name: 'Primary', createdAt: Date.now(), items }] };
    } catch (_) {
      return null;
    }
  }

  function loadModel() {
    try {
      const stored = JSON.parse(localStorage.getItem(WATCHLISTS_KEY) || 'null');
      const normalized = normalizeModel(stored, false);
      if (normalized) return normalized;
    } catch (_) {}
    return migrateV2() || blankModel();
  }

  function saveModel() {
    try {
      localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(state.model));
    } catch (error) {
      console.warn('[hookline] local storage unavailable', error);
      toast('Browser storage is unavailable. Changes will last for this tab only.', 'alert');
    }
    updateDeskCounters();
  }

  function activeList() {
    return state.model.lists.find((list) => list.id === state.model.activeListId) || state.model.lists[0];
  }

  function selectedCandidate() {
    const list = activeList();
    return list ? list.items.find((item) => item.id === state.selectedId) || null : null;
  }

  function lastObservation(candidate) {
    return candidate && candidate.observations.length ? candidate.observations[candidate.observations.length - 1] : null;
  }

  function freshness(candidate) {
    if (candidate.lastError) return 'error';
    const observation = lastObservation(candidate);
    if (!observation) return 'unobserved';
    return Date.now() - observation.observedAt <= CURRENT_WINDOW_MS ? 'current' : 'stale';
  }

  function totalObservations() {
    return state.model.lists.reduce((listTotal, list) => (
      listTotal + list.items.reduce((itemTotal, item) => itemTotal + item.observations.length, 0)
    ), 0);
  }

  let rpcSequence = 0;
  async function rpcCall(method, params) {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 'desk-' + Date.now() + '-' + ++rpcSequence }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new Error('Hookline RPC returned an unreadable response.');
    }
    if (!response.ok || payload.error) {
      throw new Error(payload && payload.error ? payload.error.message : 'Hookline RPC request failed.');
    }
    return payload.result;
  }

  async function readHook(chainId, address) {
    const startedAt = performance.now();
    const [hook, chainStatus] = await Promise.all([
      rpcCall('hookline_getHook', [chainId, address]),
      rpcCall('hookline_chainStatus', [chainId]).catch(() => null),
    ]);
    if (!hook || typeof hook !== 'object' || !hook.permissions) throw new Error('Hookline returned incomplete contract evidence.');
    if (!Number.isFinite(hook.codeByteLength) || hook.codeByteLength === 0) {
      throw new Error('No deployed bytecode was found at this address on the selected chain.');
    }
    const evidence = normalizeEvidence(hook, chainId, address);
    const observation = normalizeObservation({
      observedAt: Date.now(),
      block: chainStatus && chainStatus.status === 'healthy' ? chainStatus.blockNumber : null,
      codeByteLength: evidence.codeByteLength,
      runtimeFingerprint: evidence.runtimeFingerprint,
      owner: evidence.owner,
      ownerProbeStatus: evidence.ownerProbeStatus,
      ownerProbeError: evidence.ownerProbeError,
      permissions: evidence.permissions,
      latencyMs: Number.isFinite(evidence.latencyMs) ? evidence.latencyMs : performance.now() - startedAt,
    }, chainId, address);
    return { evidence, observation };
  }

  function appendData(container, label, value, mono) {
    container.append(makeElement('div', 'label', label));
    container.append(makeElement('div', mono ? 'value mono' : 'value', value == null || value === '' ? 'unavailable' : value));
  }

  function renderPermissions(target, permissions) {
    target.replaceChildren();
    const normalized = permissions && Array.isArray(permissions.flags) ? permissions : { flags: [] };
    normalized.flags.forEach((flag) => {
      const item = makeElement('div', 'flag');
      item.setAttribute('aria-pressed', flag.enabled ? 'true' : 'false');
      item.append(makeElement('span', 'flag-name', flag.name));
      item.append(makeElement('span', 'flag-val', flag.enabled ? 'enabled · bit ' + flag.bit : 'off · bit ' + flag.bit));
      target.append(item);
    });
  }

  function renderEvidence(target, evidence, observation, error) {
    target.replaceChildren();
    appendData(target, 'Chain', evidence ? CHAINS[evidence.chainId].name + ' · ' + evidence.chainId : 'unavailable');
    appendData(target, 'Address', evidence && evidence.address, true);
    appendData(target, 'Code size', evidence && Number.isFinite(evidence.codeByteLength) ? formatNumber(evidence.codeByteLength) + ' bytes' : null);
    appendData(target, 'Runtime SHA-256', evidence && fingerprintOf(evidence), true);
    appendData(target, 'Owner', evidence && evidence.owner, true);
    appendData(target, 'Owner probe', evidence && evidence.ownerProbeStatus);
    appendData(target, 'Observed block', observation && Number.isSafeInteger(observation.block) ? formatNumber(observation.block) : null);
    appendData(target, 'Observed at', observation && observation.observedAt ? formatDate(observation.observedAt) : null);
    appendData(target, 'RPC latency', evidence ? formatLatency(evidence.latencyMs) : null);
    if (error) appendData(target, 'Last refresh error', error);
  }

  function renderInspected(result) {
    const heading = $('evidence-heading');
    $('evidence-empty').hidden = true;
    heading.textContent = CHAINS[result.evidence.chainId].code + ' · ' + shorten(result.evidence.address, 10, 8);
    renderEvidence($('inspect-evidence-grid'), result.evidence, result.observation, null);
    renderPermissions($('inspect-perm-grid'), result.evidence.permissions);
    $('inspect-permissions').hidden = false;
    $('inspect-freshness').textContent = 'Observed ' + relativeTime(result.observation.observedAt) + '. Evidence reflects one live RPC read.';
    $('save-inspect-btn').disabled = false;
  }

  async function handleInspect(event) {
    event.preventDefault();
    const chain = validateChainId($('inspect-chain').value);
    const address = validateAddress($('inspect-address').value);
    const errorNode = $('inspect-form-error');
    errorNode.textContent = '';
    if (!chain.ok || !address.ok) {
      errorNode.textContent = chain.ok ? address.message : chain.message;
      return;
    }
    const button = $('inspect-btn');
    button.disabled = true;
    button.textContent = 'Inspecting…';
    $('save-inspect-btn').disabled = true;
    try {
      const result = await readHook(chain.chainId, address.address);
      state.inspected = result;
      state.inspectionsThisSession += 1;
      renderInspected(result);
      updateDeskCounters();
      toast('Live evidence captured.', 'info');
    } catch (error) {
      state.inspected = null;
      errorNode.textContent = error.message;
      $('evidence-heading').textContent = 'Inspection failed';
      $('evidence-empty').hidden = false;
      $('evidence-empty').textContent = error.message;
      $('inspect-evidence-grid').replaceChildren();
      $('inspect-permissions').hidden = true;
    } finally {
      button.disabled = false;
      button.textContent = 'Inspect hook';
    }
  }

  function saveInspected() {
    if (!state.inspected) return toast('Inspect an address before saving it.', 'alert');
    const list = activeList();
    const key = candidateKey(state.inspected.evidence);
    if (list.items.some((candidate) => candidateKey(candidate) === key)) return toast('That contract is already in the active list.', 'alert');
    if (list.items.length >= MAX_ITEMS_PER_LIST) return toast('The active list is at its 100-contract limit.', 'alert');
    const candidate = {
      id: makeId('contract'),
      chainId: state.inspected.evidence.chainId,
      address: state.inspected.evidence.address,
      label: cleanString($('inspect-label').value, 80) || null,
      evidence: state.inspected.evidence,
      observations: [state.inspected.observation],
      lastError: null,
      lastAttemptAt: Date.now(),
    };
    list.items.push(candidate);
    state.selectedId = candidate.id;
    saveModel();
    renderWatchlists();
    toast('Saved to ' + list.name + '.', 'info');
  }

  function createList() {
    if (state.model.lists.length >= MAX_LISTS) return toast('The 20-list limit has been reached.', 'alert');
    const name = cleanString(window.prompt('Name this watchlist:'), 60);
    if (!name) return;
    const list = { id: makeId('list'), name, createdAt: Date.now(), items: [] };
    state.model.lists.push(list);
    state.model.activeListId = list.id;
    state.selectedId = null;
    saveModel();
    renderWatchlists();
  }

  function renameList(list) {
    const name = cleanString(window.prompt('Rename this watchlist:', list.name), 60);
    if (!name || name === list.name) return;
    list.name = name;
    saveModel();
    renderWatchlists();
  }

  function deleteList(list) {
    if (state.model.lists.length === 1) return toast('The final watchlist cannot be deleted.', 'alert');
    if (!window.confirm('Delete "' + list.name + '" and its saved local evidence?')) return;
    state.model.lists = state.model.lists.filter((candidate) => candidate.id !== list.id);
    if (state.model.activeListId === list.id) state.model.activeListId = state.model.lists[0].id;
    state.selectedId = null;
    saveModel();
    renderWatchlists();
  }

  function renderListRail() {
    const target = $('lists-list');
    target.replaceChildren();
    state.model.lists.forEach((list) => {
      const item = makeElement('li', 'list-item' + (list.id === state.model.activeListId ? ' active' : ''));
      const select = makeElement('button', 'list-select');
      select.type = 'button';
      select.setAttribute('aria-current', list.id === state.model.activeListId ? 'true' : 'false');
      select.append(makeElement('span', 'list-name', list.name));
      select.append(makeElement('span', 'list-count', String(list.items.length)));
      select.addEventListener('click', () => {
        state.model.activeListId = list.id;
        state.selectedId = null;
        saveModel();
        renderWatchlists();
      });
      const actions = makeElement('span', 'list-item-menu');
      const rename = makeElement('button', 'list-mini-action', 'Rename');
      rename.type = 'button';
      rename.addEventListener('click', () => renameList(list));
      const remove = makeElement('button', 'list-mini-action', 'Delete');
      remove.type = 'button';
      remove.disabled = state.model.lists.length === 1;
      remove.addEventListener('click', () => deleteList(list));
      actions.append(rename, remove);
      item.append(select, actions);
      target.append(item);
    });
    const total = state.model.lists.reduce((sum, list) => sum + list.items.length, 0);
    $('lists-stats').textContent = state.model.lists.length + ' list' + (state.model.lists.length === 1 ? '' : 's') + ' · ' + total + ' saved contract' + (total === 1 ? '' : 's');
  }

  function filteredCandidates() {
    const list = activeList();
    const query = $('watchlist-search').value.trim().toLowerCase();
    const chain = $('watchlist-chain-filter').value;
    const stateFilter = $('watchlist-state-filter').value;
    return list.items.filter((candidate) => {
      if (chain !== 'all' && String(candidate.chainId) !== chain) return false;
      if (stateFilter !== 'all' && freshness(candidate) !== stateFilter) return false;
      if (query && !((candidate.label || '') + ' ' + candidate.address).toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function makeStatusChip(status) {
    const chip = makeElement('span', 'status-chip ' + status);
    chip.append(makeElement('span', 'status-dot'));
    chip.append(document.createTextNode(status));
    return chip;
  }

  function renderWatchTable() {
    const list = activeList();
    const items = filteredCandidates();
    const tbody = $('watchlist-tbody');
    tbody.replaceChildren();
    $('active-list-name').textContent = list.name;
    $('refresh-list-btn').disabled = state.refreshing || list.items.length === 0;
    const empty = $('watchlist-empty');
    const table = $('watchlist-table');
    empty.hidden = items.length !== 0;
    table.hidden = items.length === 0;
    if (!items.length) {
      empty.textContent = list.items.length ? 'No contracts match the active filters.' : 'No contracts saved here. Inspect a live address, then save the evidence to this list.';
    }
    items.forEach((candidate) => {
      const observation = lastObservation(candidate);
      const row = document.createElement('tr');
      if (candidate.id === state.selectedId) row.classList.add('selected');
      row.tabIndex = 0;
      row.setAttribute('aria-label', (candidate.label || candidate.address) + ' on ' + CHAINS[candidate.chainId].name);
      const chainCell = document.createElement('td');
      chainCell.append(makeElement('span', 'chain-chip', CHAINS[candidate.chainId].code));
      const addressCell = document.createElement('td');
      addressCell.append(makeElement('strong', 'contract-label', candidate.label || shorten(candidate.address, 9, 7)));
      addressCell.append(makeElement('code', 'address', candidate.address));
      const observedCell = makeElement('td', '', observation ? relativeTime(observation.observedAt) : 'never');
      const blockCell = makeElement('td', 'mono', observation && Number.isSafeInteger(observation.block) ? formatNumber(observation.block) : 'unavailable');
      const ownerCell = makeElement('td', 'owner mono', candidate.evidence && candidate.evidence.owner ? shorten(candidate.evidence.owner, 7, 5) : 'unavailable');
      const stateCell = document.createElement('td');
      stateCell.append(makeStatusChip(freshness(candidate)));
      const actionCell = document.createElement('td');
      const refresh = makeElement('button', 'btn btn-ghost btn-compact', 'Refresh');
      refresh.type = 'button';
      refresh.addEventListener('click', (event) => {
        event.stopPropagation();
        refreshOne(candidate, refresh);
      });
      actionCell.append(refresh);
      row.append(chainCell, addressCell, observedCell, blockCell, ownerCell, stateCell, actionCell);
      const selectRow = () => {
        state.selectedId = candidate.id;
        renderWatchTable();
        renderDetail();
      };
      row.addEventListener('click', selectRow);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectRow();
        }
      });
      tbody.append(row);
    });
  }

  function populateCompare() {
    const list = activeList();
    ['cmp-left', 'cmp-right'].forEach((id) => {
      const select = $(id);
      const previous = select.value;
      select.replaceChildren();
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Select a contract';
      select.append(first);
      list.items.forEach((candidate) => {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = CHAINS[candidate.chainId].code + ' · ' + (candidate.label || shorten(candidate.address, 9, 6));
        select.append(option);
      });
      if (list.items.some((candidate) => candidate.id === previous)) select.value = previous;
    });
  }

  function renderDetail() {
    const detail = $('watchlist-detail');
    const candidate = selectedCandidate();
    if (!candidate) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    $('detail-label').textContent = candidate.label || shorten(candidate.address, 12, 10);
    renderEvidence($('detail-evidence'), candidate.evidence, lastObservation(candidate), candidate.lastError);
    renderPermissions($('detail-perm-grid'), candidate.evidence ? candidate.evidence.permissions : decodePermissions(candidate.address));
  }

  function renderWatchlists() {
    renderListRail();
    renderWatchTable();
    populateCompare();
    renderDetail();
    updateDeskCounters();
  }

  async function updateCandidate(candidate) {
    candidate.lastAttemptAt = Date.now();
    try {
      const result = await readHook(candidate.chainId, candidate.address);
      candidate.evidence = result.evidence;
      candidate.observations.push(result.observation);
      candidate.observations = candidate.observations.slice(-MAX_OBSERVATIONS);
      candidate.lastError = null;
      saveModel();
      return true;
    } catch (error) {
      candidate.lastError = cleanString(error.message, 300) || 'Refresh failed.';
      saveModel();
      throw error;
    }
  }

  async function refreshOne(candidate, button) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Refreshing…';
    }
    try {
      await updateCandidate(candidate);
      toast('Contract evidence refreshed.', 'info');
    } catch (error) {
      toast(error.message + ' Last successful evidence was preserved.', 'alert');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Refresh';
      }
      renderWatchlists();
    }
  }

  async function refreshActiveList() {
    const list = activeList();
    if (!list.items.length || state.refreshing) return;
    state.refreshing = true;
    renderWatchTable();
    const progress = $('refresh-progress');
    progress.hidden = false;
    progress.max = list.items.length;
    progress.value = 0;
    let cursor = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    async function worker() {
      while (cursor < list.items.length) {
        const candidate = list.items[cursor++];
        try {
          await updateCandidate(candidate);
          succeeded += 1;
        } catch (_) {
          failed += 1;
        } finally {
          completed += 1;
          progress.value = completed;
        }
      }
    }
    await Promise.all([worker(), worker()]);
    state.refreshing = false;
    progress.hidden = true;
    renderWatchlists();
    toast('Refresh finished: ' + succeeded + ' current, ' + failed + ' error' + (failed === 1 ? '' : 's') + '.', failed ? 'alert' : 'info');
  }

  function removeSelected() {
    const list = activeList();
    const candidate = selectedCandidate();
    if (!candidate) return;
    if (!window.confirm('Remove ' + (candidate.label || candidate.address) + ' from this list?')) return;
    list.items = list.items.filter((item) => item.id !== candidate.id);
    state.selectedId = null;
    saveModel();
    renderWatchlists();
  }

  function compareCandidates(left, right) {
    const result = $('cmp-result');
    result.replaceChildren();
    if (!left || !right) {
      result.append(makeElement('p', 'comp-refusal', 'Select two contracts to compare.'));
      return;
    }
    if (left.id === right.id) {
      result.append(makeElement('p', 'comp-refusal', 'Choose two different contracts.'));
      return;
    }
    if (left.chainId !== right.chainId) {
      result.append(makeElement('p', 'comp-refusal', 'Cross-chain comparison refused. Select two contracts on the same chain.'));
      return;
    }
    const panel = makeElement('div', 'comp-ok');
    const rows = [
      ['Chain', CHAINS[left.chainId].name],
      ['Runtime fingerprint', fingerprintOf(left.evidence) && fingerprintOf(left.evidence) === fingerprintOf(right.evidence) ? 'match' : 'different or unavailable'],
      ['Owner', left.evidence && right.evidence && left.evidence.owner === right.evidence.owner ? 'match' : 'different or unavailable'],
      ['Code size', (left.evidence && left.evidence.codeByteLength != null ? left.evidence.codeByteLength : 'unavailable') + ' / ' + (right.evidence && right.evidence.codeByteLength != null ? right.evidence.codeByteLength : 'unavailable')],
      ['Observed blocks', (lastObservation(left)?.block ?? 'unavailable') + ' / ' + (lastObservation(right)?.block ?? 'unavailable')],
    ];
    rows.forEach(([label, value]) => {
      const row = makeElement('div', 'cmp-result-row');
      row.append(makeElement('span', 'label', label));
      row.append(makeElement('code', '', value));
      panel.append(row);
    });
    const title = makeElement('h3', '', 'Permission delta');
    panel.append(title);
    const delta = makeElement('div', 'perm-delta');
    const leftFlags = normalizePermissions(left.evidence && left.evidence.permissions, left.address).flags;
    const rightFlags = normalizePermissions(right.evidence && right.evidence.permissions, right.address).flags;
    leftFlags.forEach((flag, index) => {
      const row = makeElement('div', 'row');
      row.append(makeElement('span', 'cell flag-name', flag.name));
      row.append(makeElement('span', 'cell a' + (flag.enabled ? ' enabled' : ''), flag.enabled ? 'on' : 'off'));
      row.append(makeElement('span', 'cell b' + (rightFlags[index].enabled ? ' enabled' : ''), rightFlags[index].enabled ? 'on' : 'off'));
      row.append(makeElement('span', 'cell ' + (flag.enabled === rightFlags[index].enabled ? 'same' : 'diff'), flag.enabled === rightFlags[index].enabled ? 'same' : 'changed'));
      delta.append(row);
    });
    panel.append(delta);
    result.append(panel);
  }

  function handleCompare(event) {
    event.preventDefault();
    const list = activeList();
    compareCandidates(
      list.items.find((item) => item.id === $('cmp-left').value),
      list.items.find((item) => item.id === $('cmp-right').value),
    );
  }

  function exportWatchlists() {
    const blob = new Blob([JSON.stringify(state.model, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'hookline-watchlists-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast('Watchlists exported.', 'info');
  }

  function uniqueImportedName(name) {
    const names = new Set(state.model.lists.map((list) => list.name.toLowerCase()));
    if (!names.has(name.toLowerCase())) return name;
    let suffix = 2;
    while (names.has((name + ' import ' + suffix).toLowerCase())) suffix += 1;
    return name + ' import ' + suffix;
  }

  async function importWatchlists(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Import exceeds the 1 MB file limit.');
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      throw new Error('Import is not valid JSON.');
    }
    const incoming = normalizeModel(parsed, true);
    if (state.model.lists.length + incoming.lists.length > MAX_LISTS) {
      throw new Error('Import would exceed the 20-list total limit.');
    }
    incoming.lists.forEach((list) => {
      const keys = new Set();
      list.id = makeId('list');
      list.name = uniqueImportedName(list.name);
      list.items = list.items.filter((item) => {
        const key = candidateKey(item);
        if (keys.has(key)) return false;
        keys.add(key);
        item.id = makeId('contract');
        return true;
      });
      state.model.lists.push(list);
    });
    saveModel();
    renderWatchlists();
    toast(incoming.lists.length + ' list' + (incoming.lists.length === 1 ? '' : 's') + ' imported.', 'info');
  }

  function metricStat(label, value) {
    const stat = makeElement('div', 'stat');
    stat.append(makeElement('span', 'stat-label', label));
    stat.append(makeElement('strong', 'stat-value', value));
    return stat;
  }

  function renderTelemetry(metrics) {
    const summary = $('telemetry-summary');
    const body = $('chain-table-body');
    summary.replaceChildren();
    body.replaceChildren();
    if (!metrics) {
      summary.append(metricStat('Telemetry', 'unavailable'));
      const row = document.createElement('tr');
      const cell = makeElement('td', '', 'Live chain telemetry is unavailable.');
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
      $('observe-health').textContent = 'unavailable';
      $('observe-base-block').textContent = 'unavailable';
      return;
    }
    summary.append(
      metricStat('Healthy chains', metrics.healthyChains + ' / ' + metrics.supportedChains),
      metricStat('Base latest block', metrics.baseLatestBlock == null ? 'unavailable' : formatNumber(metrics.baseLatestBlock)),
      metricStat('Generated', relativeTime(Date.parse(metrics.generatedAt))),
      metricStat('Saved observations', formatNumber(totalObservations())),
    );
    $('observe-health').textContent = metrics.healthyChains + ' / ' + metrics.supportedChains;
    $('observe-base-block').textContent = metrics.baseLatestBlock == null ? 'unavailable' : formatNumber(metrics.baseLatestBlock);
    metrics.chains.forEach((chain) => {
      const row = document.createElement('tr');
      const status = document.createElement('td');
      status.append(makeStatusChip(chain.healthy ? 'current' : 'error'));
      status.lastChild.lastChild.textContent = chain.healthy ? 'healthy' : 'error';
      row.append(
        makeElement('td', '', chain.name || CHAINS[chain.chainId]?.name || 'Unknown'),
        makeElement('td', 'mono', chain.chainId),
        status,
        makeElement('td', 'mono', chain.blockNumber == null ? 'unavailable' : formatNumber(chain.blockNumber)),
        makeElement('td', 'mono', formatLatency(chain.latencyMs)),
        makeElement('td', '', chain.error || 'none'),
      );
      body.append(row);
    });
  }

  function validMetrics(raw) {
    if (!raw || !Array.isArray(raw.chains)) return null;
    const supportedChains = Number(raw.supportedChains);
    const healthyChains = Number(raw.healthyChains);
    if (!Number.isInteger(supportedChains) || !Number.isInteger(healthyChains)) return null;
    return {
      supportedChains,
      healthyChains,
      baseLatestBlock: Number.isSafeInteger(raw.baseLatestBlock) ? raw.baseLatestBlock : null,
      generatedAt: cleanString(raw.generatedAt, 80),
      chains: raw.chains.map((chain) => ({
        chainId: Number(chain.chainId),
        name: cleanString(chain.name, 80),
        healthy: Boolean(chain.healthy),
        blockNumber: Number.isSafeInteger(chain.blockNumber) ? chain.blockNumber : null,
        latencyMs: Number.isFinite(Number(chain.latencyMs)) ? Number(chain.latencyMs) : null,
        error: cleanString(chain.error, 300) || null,
      })),
    };
  }

  function renderTopStatus() {
    const node = $('top-live');
    node.className = 'live-indicator';
    if (state.healthOk === false) {
      node.classList.add('offline');
      node.textContent = 'OFFLINE';
    } else if (state.metrics && state.metrics.healthyChains < state.metrics.supportedChains) {
      node.classList.add('loading');
      node.textContent = 'PARTIAL ' + state.metrics.healthyChains + '/' + state.metrics.supportedChains;
    } else if (state.healthOk === true || (state.metrics && state.metrics.healthyChains > 0)) {
      node.classList.add('live');
      node.textContent = 'LIVE';
    } else {
      node.classList.add('loading');
      node.textContent = 'PROBING';
    }
  }

  async function loadTelemetry(showMessage) {
    const button = $('refresh-telemetry-btn');
    button.disabled = true;
    try {
      const response = await fetch('/metrics', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Metrics request failed.');
      const metrics = validMetrics(await response.json());
      if (!metrics) throw new Error('Metrics response was incomplete.');
      state.metrics = metrics;
      renderTelemetry(metrics);
      if (showMessage) toast('Network telemetry refreshed.', 'info');
    } catch (error) {
      state.metrics = null;
      renderTelemetry(null);
      if (showMessage) toast(error.message, 'alert');
    } finally {
      button.disabled = false;
      renderTopStatus();
    }
  }

  async function loadHealth() {
    try {
      const response = await fetch('/health', { headers: { Accept: 'application/json' } });
      const body = response.ok ? await response.json() : null;
      state.healthOk = Boolean(body && body.status === 'live');
    } catch (_) {
      state.healthOk = false;
    }
    renderTopStatus();
  }

  function updateDeskCounters() {
    $('observe-session-count').textContent = formatNumber(state.inspectionsThisSession);
    $('observe-saved-count').textContent = formatNumber(totalObservations());
  }

  function viewFromHash() {
    const value = location.hash.replace(/^#\/?/, '') || 'observatory';
    return VIEWS.has(value) ? value : 'observatory';
  }

  function renderView() {
    const view = viewFromHash();
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === 'view-' + view));
    $$('[data-view]').forEach((link) => {
      const active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (view === 'watchlists') renderWatchlists();
    if (view === 'network') renderTelemetry(state.metrics);
    window.scrollTo(0, 0);
  }

  function toast(message, kind) {
    const node = $('hookline-toast');
    node.textContent = message;
    node.className = 'toast show ' + (kind || 'info');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.className = 'toast'; }, 4200);
  }

  async function copyText(value, button) {
    const text = value.startsWith('/') ? location.origin + value : value;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      if (button && button.classList.contains('copy-icon-btn')) {
        const originalLabel = button.getAttribute('aria-label');
        button.setAttribute('aria-label', 'Copied');
        button.classList.add('copied');
        setTimeout(() => { button.setAttribute('aria-label', originalLabel); button.classList.remove('copied'); }, 1400);
      } else if (button) {
        const original = button.textContent;
        button.textContent = 'Copied';
        button.classList.add('copied');
        setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1400);
      }
      toast('Copied to clipboard.', 'info');
    } catch (_) {
      toast('Copy failed. Select the value manually.', 'alert');
    }
  }

  function setupWebMCP() {
    if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') return;
    const tools = [
      {
        name: 'inspect_hook',
        description: 'Fetch live Hookline evidence for one supported-chain contract.',
        inputSchema: { type: 'object', required: ['chainId', 'address'], additionalProperties: false, properties: { chainId: { type: 'integer', enum: SUPPORTED_CHAINS }, address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } } },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ chainId, address }) => {
          const chain = validateChainId(chainId);
          const checked = validateAddress(address);
          if (!chain.ok || !checked.ok) throw new Error(chain.ok ? checked.message : chain.message);
          return readHook(chain.chainId, checked.address);
        },
      },
      {
        name: 'decode_hook_address',
        description: 'Decode the canonical 14 permission bits embedded in a hook address.',
        inputSchema: { type: 'object', required: ['address'], additionalProperties: false, properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } } },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ address }) => {
          const checked = validateAddress(address);
          if (!checked.ok) throw new Error(checked.message);
          return decodePermissions(checked.address);
        },
      },
      {
        name: 'list_hookline_watchlists',
        description: 'Return locally saved Hookline list names and contract identities.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async () => state.model.lists.map((list) => ({ name: list.name, contracts: list.items.map((item) => ({ chainId: item.chainId, address: item.address, label: item.label, freshness: freshness(item) })) })),
      },
    ];
    tools.forEach((tool) => {
      try { document.modelContext.registerTool(tool); } catch (error) { console.warn('[hookline] WebMCP registration failed', tool.name, error); }
    });
  }

  function setupEvents() {
    $$('[data-doc-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const section = document.getElementById(button.dataset.docTarget);
        if (!section) return;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      });
    });
    $('inspect-form').addEventListener('submit', handleInspect);
    $('save-inspect-btn').addEventListener('click', saveInspected);
    $('new-list-btn').addEventListener('click', createList);
    $('refresh-list-btn').addEventListener('click', refreshActiveList);
    $('watchlist-search').addEventListener('input', renderWatchTable);
    $('watchlist-chain-filter').addEventListener('change', renderWatchTable);
    $('watchlist-state-filter').addEventListener('change', renderWatchTable);
    $('add-candidate-btn').addEventListener('click', () => {
      location.hash = '#/observatory';
      setTimeout(() => $('inspect-address').focus(), 0);
    });
    $('compare-form').addEventListener('submit', handleCompare);
    $('refresh-candidate-btn').addEventListener('click', () => {
      const candidate = selectedCandidate();
      if (candidate) refreshOne(candidate, $('refresh-candidate-btn'));
    });
    $('remove-candidate-btn').addEventListener('click', removeSelected);
    $('close-detail-btn').addEventListener('click', () => { state.selectedId = null; renderWatchlists(); });
    $('export-btn').addEventListener('click', exportWatchlists);
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', async (event) => {
      try { await importWatchlists(event.target.files && event.target.files[0]); }
      catch (error) { toast(error.message, 'alert'); }
      finally { event.target.value = ''; }
    });
    $('refresh-telemetry-btn').addEventListener('click', () => loadTelemetry(true));
    $('top-copy-ca').addEventListener('click', (event) => copyText(TOKEN_CA, event.currentTarget));
    $('strip-copy-ca').addEventListener('click', (event) => copyText(TOKEN_CA, event.currentTarget));
    $$('[data-copy]').forEach((button) => button.addEventListener('click', (event) => copyText(button.dataset.copy, event.currentTarget)));
    window.addEventListener('hashchange', renderView);
  }

  function init() {
    state.model = loadModel();
    saveModel();
    setupEvents();
    renderWatchlists();
    renderView();
    setupWebMCP();
    loadHealth();
    loadTelemetry(false);
  }

  window.Hookline = {
    getState: () => JSON.parse(JSON.stringify(state.model)),
    decodePermissions,
    validateAddress,
    inspect: (chainId, address) => readHook(chainId, String(address).toLowerCase()),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
