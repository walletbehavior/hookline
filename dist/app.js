/** Hookline multichain hooks analytics desk. Vanilla browser runtime. */
(function () {
  'use strict';

  const CHAINS = Object.freeze({
    1: { name: 'Ethereum', code: 'ETH' },
    56: { name: 'BNB Chain', code: 'BNB' },
    8453: { name: 'Base', code: 'BASE' },
    42161: { name: 'Arbitrum One', code: 'ARB' },
    4663: { name: 'Robinhood Chain', code: 'RHB' },
  });
  const SUPPORTED_CHAINS = Object.freeze([1, 56, 8453, 42161, 4663]);
  const PERMISSION_FLAGS = Object.freeze([
    'beforeInitialize', 'afterInitialize', 'beforeAddLiquidity', 'afterAddLiquidity',
    'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeSwap', 'afterSwap',
    'beforeDonate', 'afterDonate', 'beforeSwapReturnDelta', 'afterSwapReturnDelta',
    'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta',
  ]);
  const WATCHLISTS_KEY = 'hookline:watchlists:v3';
  const WATCHLISTS_V2_KEY = 'hookline:watchlist:v2';
  const MAX_LISTS = 20;
  const MAX_ITEMS_PER_LIST = 100;
  const MAX_OBSERVATIONS = 100;
  const MAX_IMPORT_BYTES = 1024 * 1024;
  const CURRENT_WINDOW_MS = 15 * 60 * 1000;
  const VIEWS = new Set(['board', 'projects', 'activity', 'tape', 'observatory', 'watchlists', 'network', 'docs']);
  const BOARD_PAGE_SIZE = 50;
  const CHAIN_COLORS = Object.freeze({
    1: '#8b9aee', 10: '#ff5364', 56: '#f0b90b', 130: '#ff3d96', 137: '#8e6cff', 143: '#836ef9',
    146: '#d7d0c5', 480: '#72a892', 1868: '#7590bd', 4663: '#839a79', 8453: '#5e84b2',
    42161: '#3f8ed0', 42220: '#fcff52', 43114: '#e84142', 57073: '#8a68ff', 81457: '#ffdfb5',
  });
  const DEXSCREENER_CHAIN_SLUGS = Object.freeze({
    1: 'ethereum', 10: 'optimism', 56: 'bsc', 130: 'unichain', 137: 'polygon', 143: 'monad',
    146: 'sonic', 480: 'worldchain', 1868: 'soneium', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum',
    42220: 'celo', 43114: 'avalanche', 57073: 'ink', 81457: 'blast',
  });
  const MARKET_RESOLVER_VERSION = '5';
  const MARKET_CACHE_KEY = 'hookline:market-cache:v5';
  const MARKET_CACHE_FRESH_MS = 10 * 60 * 1000;
  const MARKET_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
  const MARKET_CACHE_MAX_ENTRIES = 80;
  const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const EXECUTION_CHAIN_IDS = new Set([1, 56, 4663, 8453]);
  const EXECUTION_PREFERENCES_KEY = 'hookline:trade-preferences:v1';
  const EXECUTION_DEFAULTS = Object.freeze({ slippageBps: 50, buyPresets: ['0.01', '0.05', '0.1', '1'], sellPresets: [25, 50, 75, 100] });
  const EXECUTION_CHAINS = Object.freeze({
    1: { chainId: '0x1', chainName: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://eth.drpc.org'], blockExplorerUrls: ['https://etherscan.io'] },
    56: { chainId: '0x38', chainName: 'BNB Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
    4663: { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://explorer.mainnet.chain.robinhood.com'] },
    8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  });

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
    pendingLocalReads: 0,
    accountController: null,
    wallets: { controller: null, loading: null, provider: null, source: null, unbind: null },
    board: null,
    boardItems: [],
    runtimeFamilies: null,
    boardSelectedId: null,
    boardVisible: BOARD_PAGE_SIZE,
    boardProjectsOnly: false,
    boardMode: 'hook',
    tokenRelationships: [],
    tokenLoading: false,
    tokenRequest: 0,
    tokenSearchTimer: null,
    boardEvidence: new Map(),
    boardLoading: new Set(),
    projects: { registry: null, loading: null, error: '', detailRequest: 0, detail: null, activityRequest: 0, events: [], activityLoaded: false, activityGeneratedAt: null, receipts: [], contributionBusy: false, compareIds: [], compareRequest: 0, comparison: null, comparisonError: '' },
    tape: { status: null, activity: null, mode: 'swaps', pools: [], swaps: [], cursors: { pools: null, swaps: null }, loaded: { pools: false, swaps: false }, loading: false, error: '' },
    execution: {
      module: null,
      modulePromise: null,
      item: null,
      market: null,
      side: 'buy',
      account: null,
      quote: null,
      receipt: null,
      submittedHash: null,
      pendingApprovalHash: null,
      pendingProvider: null,
      pendingIntentId: null,
      capability: null,
      busy: false,
      tokenCache: new Map(),
      preferences: null,
      pendingSellPercent: null,
      quoteContext: null,
      handoffRequest: 0,
      handoffHash: null,
    },
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

  function loadMarketCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(MARKET_CACHE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : {};
    } catch (_) {
      return {};
    }
  }

  function marketCacheEntry(item, freshOnly) {
    const entry = loadMarketCache()[item.id];
    const observedAt = Number(entry?.observedAt);
    const maxAge = freshOnly ? MARKET_CACHE_FRESH_MS : MARKET_CACHE_STALE_MS;
    if (!Array.isArray(entry?.markets) || !Number.isFinite(observedAt) || Date.now() - observedAt > maxAge) return null;
    return { markets: entry.markets, observedAt };
  }

  function persistMarketCache(item, markets, observedAt) {
    try {
      const entries = loadMarketCache();
      entries[item.id] = { observedAt: Number(observedAt) || Date.now(), markets };
      const ordered = Object.entries(entries)
        .sort((left, right) => Number(right[1]?.observedAt || 0) - Number(left[1]?.observedAt || 0))
        .slice(0, MARKET_CACHE_MAX_ENTRIES);
      localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify({ entries: Object.fromEntries(ordered) }));
    } catch (_) {
      // Storage can be disabled or full; the in-memory cache still works.
    }
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

  function permissionProfiles(address) {
    const enabled = new Set(decodePermissions(address).flags.filter((flag) => flag.enabled).map((flag) => flag.name));
    const profiles = [];
    if ([...enabled].some((name) => name.toLowerCase().includes('swap'))) profiles.push('swap');
    if ([...enabled].some((name) => name.toLowerCase().includes('liquidity'))) profiles.push('liquidity');
    if ([...enabled].some((name) => name.toLowerCase().includes('initialize'))) profiles.push('initialize');
    if ([...enabled].some((name) => name.toLowerCase().includes('donate'))) profiles.push('donate');
    if ([...enabled].some((name) => name.toLowerCase().includes('returndelta'))) profiles.push('delta');
    return { enabled: [...enabled], profiles };
  }

  function capabilityPhrases(address) {
    const enabled = new Set(decodePermissions(address).flags.filter((flag) => flag.enabled).map((flag) => flag.name));
    const has = (name) => enabled.has(name);
    const parts = [];
    if (has('beforeSwapReturnDelta')) parts.push('swap input changes');
    if (has('afterSwapReturnDelta')) parts.push('swap output changes');
    if (!has('beforeSwapReturnDelta') && has('beforeSwap')) parts.push('pre-swap checks');
    if (!has('afterSwapReturnDelta') && has('afterSwap')) parts.push('post-swap processing');
    if (has('beforeAddLiquidity') || has('beforeRemoveLiquidity')) parts.push('liquidity gating');
    if (has('afterAddLiquidityReturnDelta') || has('afterRemoveLiquidityReturnDelta')) parts.push('liquidity settlement changes');
    if (has('beforeInitialize')) parts.push('initialization gating');
    else if (has('afterInitialize')) parts.push('post-initialization processing');
    if (has('beforeDonate') || has('afterDonate')) parts.push('donation handling');
    return parts;
  }

  function capabilitySentence(item) {
    if (!item.address) return 'Directory record, deployment not linked.';
    const parts = capabilityPhrases(item.address);
    if (!parts.length) return 'No callback permissions encoded.';
    if (parts.length > 3) return `Permits ${parts.slice(0, 3).join(', ')} + ${parts.length - 3} more.`;
    if (parts.length === 3) return `Permits ${parts[0]}, ${parts[1]}, and ${parts[2]}.`;
    if (parts.length === 2) return `Permits ${parts[0]} and ${parts[1]}.`;
    return `Permits ${parts[0]}.`;
  }

  function matchPermissionPattern(item, pattern) {
    if (pattern === 'all') return true;
    if (pattern === 'runtime-family') return Number(item.runtime?.deploymentCount) > 1;
    if (!item.address) return false;
    const enabled = new Set(decodePermissions(item.address).flags.filter((flag) => flag.enabled).map((flag) => flag.name));
    if (pattern === 'swap-intercept') return enabled.has('beforeSwap');
    if (pattern === 'swap-rewrite') return enabled.has('beforeSwapReturnDelta') || enabled.has('afterSwapReturnDelta');
    if (pattern === 'liquidity-gate') return enabled.has('beforeAddLiquidity') || enabled.has('beforeRemoveLiquidity');
    if (pattern === 'donate-handle') return enabled.has('beforeDonate') || enabled.has('afterDonate');
    if (pattern === 'return-delta') {
      return enabled.has('beforeSwapReturnDelta') || enabled.has('afterSwapReturnDelta')
        || enabled.has('afterAddLiquidityReturnDelta') || enabled.has('afterRemoveLiquidityReturnDelta');
    }
    return false;
  }


  function explorerAddressUrl(chainId, address) {
    const origins = {
      1: 'https://etherscan.io/address/',
      10: 'https://optimistic.etherscan.io/address/',
      56: 'https://bscscan.com/address/',
      130: 'https://uniscan.xyz/address/',
      137: 'https://polygonscan.com/address/',
      143: 'https://monadvision.com/address/',
      146: 'https://sonicscan.org/address/',
      480: 'https://worldscan.org/address/',
      1868: 'https://soneium.blockscout.com/address/',
      4663: 'https://explorer.mainnet.chain.robinhood.com/address/',
      8453: 'https://basescan.org/address/',
      42161: 'https://arbiscan.io/address/',
      42220: 'https://celoscan.io/address/',
      43114: 'https://snowtrace.io/address/',
      57073: 'https://explorer.inkonchain.com/address/',
      81457: 'https://blastscan.io/address/',
    };
    return origins[chainId] ? origins[chainId] + address : null;
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (number < 1000) return number.toLocaleString();
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number);
  }

  function finiteNumberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatUsd(value, compact) {
    const number = finiteNumberOrNull(value);
    if (number == null) return '—';
    if (compact && Math.abs(number) >= 1000) return '$' + compactNumber(number);
    const digits = Math.abs(number) < 0.01 ? 8 : Math.abs(number) < 1 ? 5 : 2;
    return '$' + number.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function executionModule() {
    if (state.execution.module) return Promise.resolve(state.execution.module);
    if (!state.execution.modulePromise) {
      state.execution.modulePromise = import('/execution-rail.js').then((module) => {
        state.execution.module = module;
        return module;
      });
    }
    return state.execution.modulePromise;
  }

  function exactPositiveDecimal(value) {
    return typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(value) && /[1-9]/.test(value);
  }

  function normalizeExecutionPreferences(raw) {
    const slippage = Number(raw?.slippageBps);
    const buys = Array.isArray(raw?.buyPresets) ? [...new Set(raw.buyPresets.filter(exactPositiveDecimal))].slice(0, 6) : [];
    const sells = Array.isArray(raw?.sellPresets) ? [...new Set(raw.sellPresets.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100))].slice(0, 6) : [];
    return { slippageBps: Number.isInteger(slippage) && slippage >= 1 && slippage <= 5000 ? slippage : EXECUTION_DEFAULTS.slippageBps,
      buyPresets: buys.length ? buys : [...EXECUTION_DEFAULTS.buyPresets], sellPresets: sells.length ? sells : [...EXECUTION_DEFAULTS.sellPresets] };
  }

  function loadExecutionPreferences() {
    try { return normalizeExecutionPreferences(JSON.parse(localStorage.getItem(EXECUTION_PREFERENCES_KEY) || '{}')); }
    catch (_) { return normalizeExecutionPreferences(null); }
  }

  function executionSlippageBps() {
    const value = $('execution-slippage').value.trim();
    if (!/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/.test(value)) throw new Error('Slippage must be between 0.01% and 50%, with at most two decimals.');
    const [whole, fraction = ''] = value.split('.');
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (bps < 1 || bps > 5000) throw new Error('Slippage must be between 0.01% and 50%.');
    return bps;
  }

  function renderExecutionSettingsSummary() {
    try {
      const bps = executionSlippageBps();
      $('execution-settings-summary').textContent = `${bps / 100}% slippage`;
      $('execution-settings-summary').className = bps >= 500 ? 'high-slippage' : '';
      $('execution-slippage-note').textContent = bps >= 500
        ? `High slippage: the fill may be up to ${bps / 100}% worse than quoted. Review the minimum received.`
        : 'Higher slippage can mean a worse fill. The quote shows the minimum received.';
    } catch (_) { $('execution-settings-summary').textContent = 'Check slippage'; }
  }

  function saveExecutionPreferences() {
    try {
      const buyPresets = $('execution-buy-presets').value.split(',').map((v) => v.trim());
      const sellPresets = $('execution-sell-presets').value.split(',').map((v) => v.trim());
      if (!buyPresets.length || buyPresets.length > 6 || !buyPresets.every(exactPositiveDecimal)) throw new Error('Use one to six positive buy amounts, separated by commas.');
      if (!sellPresets.length || sellPresets.length > 6 || !sellPresets.every((v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100)) throw new Error('Use one to six whole sell percentages from 1 to 100.');
      const preferences = normalizeExecutionPreferences({ slippageBps: executionSlippageBps(), buyPresets, sellPresets });
      state.execution.preferences = preferences;
      try { localStorage.setItem(EXECUTION_PREFERENCES_KEY, JSON.stringify(preferences)); }
      catch (_) { throw new Error('Settings work for this visit, but browser storage is unavailable.'); }
      $('execution-settings-status').textContent = 'Saved on this device.';
      state.accountController?.localChanged();
      renderExecutionPresets(); resetExecutionQuote();
    } catch (error) { $('execution-settings-status').textContent = error.message; resetExecutionQuote(); }
  }

  function exactBalancePercent(balance, decimals, percent) {
    if (!/^\d+$/.test(String(balance)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36
      || !Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('Wallet balance or percentage is invalid.');
    const raw = (BigInt(balance) * BigInt(percent) / 100n).toString();
    if (raw === '0') throw new Error('This percentage is below one token unit or the balance is zero.');
    const padded = raw.padStart(decimals + 1, '0');
    const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
    return `${decimals ? padded.slice(0, -decimals) : padded}${fraction ? `.${fraction}` : ''}`;
  }

  function parseExecutionRoute(hash) {
    if (!String(hash).startsWith('#/trade/')) return null;
    const match = String(hash).match(/^#\/trade\/([1-9]\d*)\/(0x[0-9a-fA-F]{40})(?:\?([^#]*))?$/);
    if (!match || !EXECUTION_CHAIN_IDS.has(Number(match[1]))) throw new Error('This trade link has an unsupported chain or invalid token address.');
    const tokenAddress = match[2].toLowerCase();
    if ([ZERO_ADDRESS, NATIVE_TOKEN_ADDRESS].includes(tokenAddress)) throw new Error('Trade links must identify the token contract.');
    const query = new URLSearchParams(match[3] || '');
    const allowed = new Set(['side', 'amount', 'slippage', 'sellPercent', 'inputAsset']);
    for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) throw new Error('This trade link contains unsupported or duplicate settings.');
    const side = query.has('side') ? query.get('side') : 'buy';
    const amount = query.get('amount');
    const slippage = query.get('slippage');
    const percent = query.get('sellPercent');
    const inputAsset = query.get('inputAsset');
    if (!['buy', 'sell'].includes(side) || (amount !== null && !exactPositiveDecimal(amount))) throw new Error('This trade link has an invalid side or amount.');
    if (slippage !== null && (!/^\d{1,4}$/.test(slippage) || Number(slippage) < 1 || Number(slippage) > 5000)) throw new Error('Trade link slippage must be from 1 to 5000 basis points.');
    if (percent !== null && (side !== 'sell' || amount !== null || !/^\d{1,3}$/.test(percent) || Number(percent) < 1 || Number(percent) > 100)) throw new Error('A sell percentage must be 1–100 and cannot be combined with an amount.');
    if (inputAsset !== null && (inputAsset !== 'native' || side !== 'buy' || amount === null)) throw new Error('Native-input settings require a buy amount.');
    return { chainId: Number(match[1]), tokenAddress, side, amount, inputAsset, slippageBps: slippage === null ? null : Number(slippage), sellPercent: percent === null ? null : Number(percent) };
  }

  function relationshipMatchesTrade(relationship, route) {
    const address = String(relationship?.hookAddress || '').toLowerCase();
    return Number(relationship?.chainId) === route.chainId && /^0x[0-9a-f]{40}$/.test(address)
      && String(relationship.hookId).toLowerCase() === `${route.chainId}_${address}`
      && new RegExp(`^${route.chainId}_0x[0-9a-f]{64}$`, 'i').test(String(relationship.poolId));
  }

  function marketForTrade(item, market, relationship, route) {
    if (item.chainId !== route.chainId || item.address.toLowerCase() !== relationship.hookAddress.toLowerCase()
      || !executionMarketReady(item, market)) return null;
    if (market.chainId != null && ![String(route.chainId), DEXSCREENER_CHAIN_SLUGS[route.chainId]].includes(String(market.chainId))) return null;
    const pool = String(market.poolId || market.pairAddress || '').toLowerCase().replace(`${route.chainId}_`, '');
    if (pool !== String(relationship.poolId).toLowerCase().slice(String(route.chainId).length + 1)) return null;
    const base = executionTokenDescriptor(market.baseToken, route.chainId);
    const quote = executionTokenDescriptor(market.quoteToken, route.chainId);
    const oriented = base.address === route.tokenAddress ? market : quote.address === route.tokenAddress
      ? { ...market, baseToken: market.quoteToken, quoteToken: market.baseToken } : null;
    if (!oriented || (route.inputAsset === 'native' && !executionTokenDescriptor(oriented.quoteToken, route.chainId).native)) return null;
    return oriented;
  }

  async function openExecutionRoute() {
    const hash = location.hash;
    if (!hash.startsWith('#/trade/') || !state.board || state.execution.handoffHash === hash) return;
    state.execution.handoffHash = hash;
    const request = ++state.execution.handoffRequest;
    try {
      const route = parseExecutionRoute(hash);
      toast('Finding this token’s hook and market…', 'info');
      const response = await fetch(`/api/token-hooks?q=${encodeURIComponent(route.tokenAddress)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.relationships)) throw new Error('Token relationships are unavailable. Open its hook profile and try again.');
      const relationships = payload.relationships.filter((row) => relationshipMatchesTrade(row, route)).slice(0, 5);
      for (const relationship of relationships) {
        const item = state.board.items.find((candidate) => candidate.id === relationship.hookId.toLowerCase() && candidate.chainId === route.chainId);
        if (!item) continue;
        const indexedMarket = marketForTrade(item, { chainId: relationship.chainId,
          pairAddress: relationship.poolId.slice(String(route.chainId).length + 1),
          baseToken: relationship.baseToken, quoteToken: relationship.quoteToken }, relationship, route);
        let markets = indexedMarket ? [indexedMarket] : [];
        if (!indexedMarket) {
          try { markets = await readHookMarkets(item, true); } catch (_) { continue; }
        }
        if (request !== state.execution.handoffRequest || location.hash !== hash) return;
        const market = markets.map((candidate) => marketForTrade(item, candidate, relationship, route)).find(Boolean);
        if (!market) continue;
        state.boardSelectedId = item.id;
        renderBoard(); renderBoardProfile();
        openExecutionDialog(item, market, route);
        return;
      }
      throw new Error(route.inputAsset === 'native'
        ? 'No native-coin input market was verified on this chain. Open the hook profile to review the actual input asset. Nothing was quoted.'
        : 'No indexed hook market was verified for this token on this chain. Nothing was quoted or signed.');
    } catch (error) { if (request === state.execution.handoffRequest && location.hash === hash) toast(error.message, 'alert'); }
  }

  function executionProvider() {
    if (state.wallets.provider) return state.wallets.provider;
    const injected = globalThis.ethereum;
    if (!injected) return null;
    if (Array.isArray(injected.providers)) return injected.providers.find((provider) => provider?.isMetaMask) || injected.providers[0] || null;
    return injected;
  }

  function hasPendingExecution() {
    return Boolean(state.execution.pendingApprovalHash || (state.execution.submittedHash && !state.execution.receipt));
  }

  function walletIdentityBusy() {
    return state.execution.busy || hasPendingExecution() || Boolean(state.accountController?.isBusy());
  }

  function bindExecutionProvider(provider) {
    state.wallets.unbind?.();
    const accountsChanged = (accounts) => {
      const selected = state.execution.account;
      const address = Array.isArray(accounts) && accounts.find(value => String(value).toLowerCase() === selected);
      const checked = validateAddress(address || accounts?.[0]);
      state.execution.account = checked.ok ? checked.address : null;
      renderWalletIdentity();
      // A wallet event invalidates an unsigned quote, never a submitted receipt.
      resetExecutionQuote();
    };
    const chainChanged = () => resetExecutionQuote();
    provider.on?.('accountsChanged', accountsChanged);
    provider.on?.('chainChanged', chainChanged);
    state.wallets.unbind = () => {
      provider.removeListener?.('accountsChanged', accountsChanged);
      provider.removeListener?.('chainChanged', chainChanged);
    };
  }

  async function selectWalletProvider({provider, address, embedded = false}) {
    if (walletIdentityBusy()) throw new Error('Finish the current wallet or account request first.');
    const checked = validateAddress(address);
    if (!checked.ok || !provider?.request) throw new Error('Invalid wallet selection.');
    const accounts = await provider.request({method:'eth_accounts'});
    if (!accounts?.some(value => String(value).toLowerCase() === checked.address)) throw new Error('Wallet selection changed.');
    if (walletIdentityBusy()) throw new Error('Finish the current wallet or account request first.');
    state.wallets.provider = provider;
    state.wallets.source = embedded ? 'embedded' : 'external';
    state.execution.account = checked.address;
    bindExecutionProvider(provider);
    resetExecutionQuote();renderWalletIdentity();
    toast('Wallet selected. Every signature still needs your confirmation.', 'info');
  }

  async function openWalletSetup() {
    if (walletIdentityBusy()) { toast('Finish the current request or check the pending transaction first.', 'alert'); return; }
    for (const id of ['account-dialog','execution-dialog']) if ($(id).open) $(id).close();
    try {
      if (!state.wallets.controller) {
        if (!state.wallets.loading) {
          const appUrl = document.querySelector('script[src*="app.js"]')?.src || location.origin + '/app.js';
          state.wallets.loading = import(new URL('./privy-wallet.js', appUrl).href).then(({mountWallets}) => {
            state.wallets.controller = mountWallets({
              isBusy: walletIdentityBusy,
              select: selectWalletProvider,
              connectBrowser: async () => {
                const injected = globalThis.ethereum;
                const provider = Array.isArray(injected?.providers) ? injected.providers.find(value=>value?.isMetaMask) || injected.providers[0] : injected;
                if (!provider?.request) throw new Error('No browser wallet found. Use the sign-in picker for mobile wallets.');
                const accounts = await provider.request({method:'eth_requestAccounts'});
                await selectWalletProvider({provider,address:accounts?.[0]});
              },
              beforeLogout: addresses => state.accountController?.signOutMatching(addresses),
              disconnected: async () => { disconnectExecutionWallet(); },
            });
          }).catch(error => {state.wallets.loading=null;throw error;});
        }
        await state.wallets.loading;
      } else state.wallets.controller.open();
    } catch { toast('Wallet setup could not load. You can still use an existing browser wallet.', 'alert'); }
  }

  function nativeSymbol(chainId) {
    return EXECUTION_CHAINS[chainId]?.nativeCurrency?.symbol || 'ETH';
  }

  function executionTokenDescriptor(raw, chainId) {
    if (!raw || typeof raw !== 'object') return null;
    const symbol = cleanString(raw.symbol, 24) || 'TOKEN';
    const address = String(raw.address || '').trim().toLowerCase();
    const native = address === ZERO_ADDRESS || address === NATIVE_TOKEN_ADDRESS;
    if (!native && !/^0x[0-9a-f]{40}$/.test(address)) return null;
    return {
      address: native ? NATIVE_TOKEN_ADDRESS : address,
      name: cleanString(raw.name, 64) || symbol,
      symbol: native ? nativeSymbol(chainId) : symbol,
      decimals: native ? 18 : null,
      native,
    };
  }

  function executionPair(side) {
    const execution = state.execution;
    const base = executionTokenDescriptor(execution.market?.baseToken, execution.item?.chainId);
    const quote = executionTokenDescriptor(execution.market?.quoteToken, execution.item?.chainId);
    if (!base || !quote) return null;
    return side === 'sell' ? { input: base, output: quote } : { input: quote, output: base };
  }

  function executionMarketReady(item, market) {
    if (!item || !market || !EXECUTION_CHAIN_IDS.has(item.chainId)) return false;
    const base = executionTokenDescriptor(market.baseToken, item.chainId);
    const quote = executionTokenDescriptor(market.quoteToken, item.chainId);
    return Boolean(base && quote && base.address !== quote.address);
  }

  function formatBaseUnits(value, decimals, maximumFractionDigits) {
    const raw = String(value || '0');
    if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return '—';
    const padded = raw.padStart(decimals + 1, '0');
    const whole = decimals ? padded.slice(0, -decimals) : padded;
    const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
    const shown = fraction.slice(0, maximumFractionDigits == null ? 8 : maximumFractionDigits).replace(/0+$/, '');
    const groupedWhole = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return groupedWhole + (shown ? `.${shown}` : '');
  }

  function decimalToHexQuantity(value) {
    const raw = String(value || '0');
    if (!/^\d+$/.test(raw)) throw new Error('Transaction value is invalid.');
    return `0x${BigInt(raw).toString(16)}`;
  }

  function setExecutionMessage(message, kind) {
    const node = $('execution-message');
    node.textContent = message || '';
    node.className = `execution-message${kind ? ` ${kind}` : ''}`;
  }

  function setExecutionBusy(busy) {
    state.execution.busy = busy;
    const locked = busy || hasPendingExecution();
    ['execution-amount', 'execution-slippage', 'execution-buy-presets', 'execution-sell-presets', 'execution-settings-save',
      'execution-side-buy', 'execution-side-sell', 'execution-wallet', 'execution-switch-wallet', 'execution-disconnect', 'execution-wallet-setup', 'top-wallet']
      .forEach((id) => { $(id).disabled = locked; });
    $$('#execution-presets button').forEach((button) => { button.disabled = locked; });
    if (!busy) renderWalletIdentity();
  }

  async function loadExecutionCapability(chainId) {
    const response = await fetch(`/api/execution/status?chainId=${encodeURIComponent(chainId)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    const capability = payload?.chains?.[0] || null;
    if (!response.ok || !capability) throw new Error('Execution quotes are unavailable on this chain.');
    state.execution.capability = capability;
    return capability;
  }

  async function loadExecutionToken(token, chainId) {
    if (token.native) return token;
    const key = `${chainId}:${token.address}`;
    const cached = state.execution.tokenCache.get(key);
    if (cached) return { ...token, ...cached };
    const response = await fetch(`/api/execution/token?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(token.address)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Number.isInteger(payload?.token?.decimals)) throw new Error('Token precision could not be verified.');
    const metadata = { decimals: payload.token.decimals };
    state.execution.tokenCache.set(key, metadata);
    return { ...token, ...metadata };
  }

  async function resolvedExecutionPair() {
    const pair = executionPair(state.execution.side);
    if (!pair) throw new Error('This market does not expose both token addresses.');
    const chainId = state.execution.item.chainId;
    const [input, output] = await Promise.all([
      loadExecutionToken(pair.input, chainId),
      loadExecutionToken(pair.output, chainId),
    ]);
    return { input, output };
  }

  function resetExecutionQuote() {
    if (hasPendingExecution()) {
      $('execution-submit').disabled = state.execution.busy;
      $('execution-submit').textContent = 'Check confirmation';
      return;
    }
    state.execution.quote = null;
    state.execution.quoteContext = null;
    state.execution.receipt = null;
    state.execution.submittedHash = null;
    state.execution.pendingIntentId = null;
    $('execution-quote').hidden = true;
    $('execution-receipt').hidden = true;
    $('execution-output').textContent = '—';
    $('execution-minimum').textContent = '—';
    $('execution-fee').textContent = '1.00% gross';
    $('execution-cashback').textContent = '0.30% instant · 0.70% net';
    const submit = $('execution-submit');
    submit.disabled = (!$('execution-amount').value.trim() && !state.execution.pendingSellPercent) || state.execution.busy;
    submit.textContent = state.execution.account ? 'Get quote' : 'Connect to quote';
  }

  function executionQuoteContext() {
    const pair = executionPair(state.execution.side);
    return JSON.stringify([state.execution.item?.chainId, state.execution.item?.address, pair?.input.address,
      pair?.output.address, state.execution.side, state.execution.account, $('execution-amount').value.trim(), executionSlippageBps()]);
  }

  function renderExecutionPresets() {
    const execution = state.execution;
    const preferences = execution.preferences || loadExecutionPreferences();
    const pair = executionPair(execution.side);
    const presets = $('execution-presets');
    presets.replaceChildren();
    const sell = execution.side === 'sell';
    const values = sell ? preferences.sellPresets : pair?.input.native ? preferences.buyPresets : [];
    values.forEach((value) => {
      const button = makeElement('button', '', sell ? `${value}%` : `${value} ${pair.input.symbol}`);
      button.type = 'button';
      button.setAttribute('aria-label', sell ? `Read balance and use ${value}%` : `Use ${value} ${pair.input.symbol}`);
      if (sell) button.setAttribute('aria-pressed', String(execution.pendingSellPercent === value));
      button.disabled = execution.busy;
      button.addEventListener('click', async () => {
        if (execution.busy) return;
        if (!sell) { $('execution-amount').value = value; execution.pendingSellPercent = null; resetExecutionQuote(); return; }
        execution.pendingSellPercent = value; $('execution-amount').value = ''; resetExecutionQuote();
        setExecutionBusy(true);
        try { await applyExecutionSellPercent(value); }
        catch (error) { setExecutionMessage(error.message || 'Wallet balance unavailable.', 'error'); }
        finally { setExecutionBusy(false); renderExecutionPresets(); resetExecutionQuote(); }
      });
      presets.append(button);
    });
    $('execution-amount-help').textContent = execution.pendingSellPercent
      ? `${execution.pendingSellPercent}% selected. Get quote reads your current ${pair?.input.symbol || 'token'} balance first.`
      : sell ? 'Percentages read your wallet balance and round down to exact token units.'
        : pair?.input.native ? `Amounts are in ${pair.input.symbol}. Review the fresh quote before signing.`
          : `Enter an amount in ${pair?.input.symbol || 'the input token'}. Native-coin presets do not apply to this pair.`;
  }

  async function applyExecutionSellPercent(percent) {
    const execution = state.execution;
    if (execution.side !== 'sell' || !execution.item) throw new Error('Choose Sell before using a balance percentage.');
    const item = execution.item, market = execution.market;
    const { provider, account } = execution.account ? { provider: executionProvider(), account: execution.account } : await connectExecutionWallet();
    if (!provider) throw new Error('Wallet provider unavailable.');
    await ensureExecutionChain(provider, item.chainId);
    const pair = await resolvedExecutionPair();
    if (pair.input.native) throw new Error('Sell percentages apply to token balances, not gas balances.');
    const raw = await provider.request({ method: 'eth_call', params: [{ to: pair.input.address, data: `0x70a08231${account.slice(2).padStart(64, '0')}` }, 'latest'] });
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(raw))) throw new Error('The wallet returned an invalid token balance.');
    const chain = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
    if (chain !== EXECUTION_CHAINS[item.chainId].chainId || execution.account !== account || execution.item !== item
      || execution.market !== market || execution.side !== 'sell') throw new Error('Wallet or market changed. Read the balance again.');
    $('execution-amount').value = exactBalancePercent(BigInt(raw).toString(), pair.input.decimals, percent);
    execution.pendingSellPercent = null;
    resetExecutionQuote(); renderExecutionPresets();
    setExecutionMessage(`${percent}% of the current ${pair.input.symbol} balance, rounded down.`, 'success');
  }

  function renderExecutionPair() {
    const pair = executionPair(state.execution.side);
    $('execution-input-symbol').textContent = pair?.input?.symbol || 'TOKEN';
    $('execution-token').textContent = pair ? `${pair.input.symbol} / ${pair.output.symbol}` : 'PAIR UNAVAILABLE';
    $('execution-side-buy').setAttribute('aria-pressed', String(state.execution.side === 'buy'));
    $('execution-side-sell').setAttribute('aria-pressed', String(state.execution.side === 'sell'));
    renderExecutionPresets();
    resetExecutionQuote();
  }

  function renderExecutionQuote(pair, quote) {
    const binding = quote.exact_binding || {};
    const intent = quote.execution_intent || null;
    const economics = intent?.fee || {};
    $('execution-output').textContent = `${formatBaseUnits(binding.buy_amount_base_units, pair.output.decimals, 8)} ${pair.output.symbol}`;
    $('execution-minimum').textContent = `${formatBaseUnits(binding.minimum_buy_amount_base_units, pair.output.decimals, 8)} ${pair.output.symbol}`;
    $('execution-fee').textContent = `${(Number(economics.gross_fee_bps || 100) / 100).toFixed(2)}% gross · ${formatBaseUnits(economics.gross_amount, pair.input.decimals, 8)} ${pair.input.symbol}`;
    $('execution-cashback').textContent = `${(Number(economics.cashback_bps || 30) / 100).toFixed(2)}% instant · ${(Number(economics.effective_fee_bps || 70) / 100).toFixed(2)}% net`;
    $('execution-quote').hidden = false;
    const submit = $('execution-submit');
    const cashbackReady = state.execution.capability?.cashback_settlement_enabled === true
      && state.execution.capability?.cashback_mode === 'instant_fee_rebate'
      && Number(state.execution.capability?.effective_fee_bps) === 70
      && economics.cashback_mode === 'instant_fee_rebate'
      && Number(economics.effective_fee_bps) === 70;
    if (!cashbackReady || !/^hxi_[0-9a-f]{32}$/.test(String(intent?.intent_id || ''))) {
      submit.disabled = true;
      submit.textContent = 'Route unavailable';
      setExecutionMessage('The instant cashback binding could not be verified. Nothing can be signed.', 'error');
      return;
    }
    const hardBlockers = Array.isArray(quote.blockers)
      ? quote.blockers.filter((blocker) => blocker !== 'allowance_required')
      : [];
    if (hardBlockers.length) {
      submit.disabled = true;
      submit.textContent = 'Route blocked';
      setExecutionMessage(hardBlockers.join(', ').replaceAll('_', ' '), 'error');
      return;
    }
    if (quote.allowance?.state === 'approval_required') {
      submit.disabled = false;
      submit.textContent = `Approve ${pair.input.symbol}`;
      setExecutionMessage('Exact-amount token approval required.', '');
      return;
    }
    if (quote.wallet_handoff_eligible && quote.unsigned_transaction) {
      submit.disabled = false;
      submit.textContent = 'Review in wallet';
      setExecutionMessage('The wallet will show the bound route and total before you sign.', '');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Route blocked';
    const blockers = Array.isArray(quote.blockers) ? quote.blockers.join(', ').replaceAll('_', ' ') : 'route unavailable';
    setExecutionMessage(blockers, 'error');
  }

  function openExecutionDialog(item, market, prefill = {}) {
    const execution = state.execution;
    if (hasPendingExecution()) {
      if (!$('execution-dialog').open) $('execution-dialog').showModal();
      toast('Check the submitted transaction before starting another trade.', 'alert'); return;
    }
    if (execution.busy) { toast('Finish the current wallet request before opening another trade.', 'alert'); return; }
    if (!executionMarketReady(item, market)) { toast('This market is not ready for execution review.', 'alert'); return; }
    execution.item = item;
    execution.market = market;
    execution.side = prefill.side === 'sell' ? 'sell' : 'buy';
    execution.preferences = loadExecutionPreferences();
    execution.pendingSellPercent = prefill.sellPercent || null;
    execution.quote = null;
    execution.capability = null;
    setExecutionBusy(false);
    $('execution-chain').textContent = item.chainName.toUpperCase();
    $('execution-pool').textContent = market.pairAddress || market.poolId || '';
    $('execution-behavior').textContent = capabilitySentence(item);
    $('execution-amount').value = prefill.amount || '';
    $('execution-slippage').value = String((prefill.slippageBps || execution.preferences.slippageBps) / 100);
    $('execution-buy-presets').value = execution.preferences.buyPresets.join(', ');
    $('execution-sell-presets').value = execution.preferences.sellPresets.join(', ');
    $('execution-settings-status').textContent = prefill.slippageBps ? 'Link settings apply to this review only. Save to reuse them.' : 'Preferences are stored on this device only.';
    $('execution-settings').open = Number(prefill.slippageBps) >= 500;
    renderExecutionSettingsSummary();
    setExecutionMessage('', '');
    $('execution-wallet').textContent = execution.account ? shorten(execution.account, 7, 5) : 'Connect wallet';
    renderExecutionPair();
    const dialog = $('execution-dialog');
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    void Promise.allSettled([executionModule(), loadExecutionCapability(item.chainId)]).then((results) => {
      if (results[1].status === 'rejected') setExecutionMessage(results[1].reason.message, 'error');
    });
  }

  function renderWalletIdentity() {
    const account = state.execution.account;
    const top = $('top-wallet');
    top.textContent = account ? shorten(account, 7, 5) : 'Wallets';
    top.classList.toggle('connected', Boolean(account));
    top.title = 'Sign in, create or choose a wallet';
    $('execution-wallet').textContent = account ? shorten(account, 7, 5) : 'Connect wallet';
    $('execution-switch-wallet').disabled = !account || hasPendingExecution() || state.execution.busy;
    $('execution-disconnect').disabled = !account || hasPendingExecution() || state.execution.busy;
    $('execution-wallet-address').textContent = account || 'No wallet connected';
  }

  function disconnectExecutionWallet() {
    if (walletIdentityBusy()) { toast('Finish the current request or check the pending transaction first.', 'alert'); return; }
    state.wallets.unbind?.();state.wallets.unbind=null;
    state.wallets.provider=null;state.wallets.source=null;
    state.execution.account = null;
    state.execution.quote = null;
    state.execution.receipt = null;
    renderWalletIdentity();
    resetExecutionQuote();
    toast('Wallet disconnected from Hookline.', 'info');
  }

  async function connectExecutionWallet() {
    if(state.accountController?.isBusy()) throw new Error('Finish the account request before connecting for a trade.');
    const provider = executionProvider();
    if (!provider || typeof provider.request !== 'function') throw new Error('Open Wallets to sign in, create a wallet or connect a mobile wallet.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const checked = validateAddress(accounts?.find(value=>String(value).toLowerCase()===state.execution.account) || accounts?.[0]);
    if (!checked.ok) throw new Error('The wallet did not return a valid account.');
    state.execution.account = checked.address;
    bindExecutionProvider(provider);
    renderWalletIdentity();
    resetExecutionQuote();
    return { provider, account: checked.address };
  }

  // Identity-only connection. Never reset an execution quote or receipt here.
  async function connectAccountWallet() {
    const provider=executionProvider();
    if(!provider?.request) throw new Error('Choose Sign in or create wallet first, then sign this account message.');
    const accounts=await provider.request({method:'eth_requestAccounts'});
    const checked=validateAddress(accounts?.find(value=>String(value).toLowerCase()===state.execution.account) || accounts?.[0]);
    if(!checked.ok) throw new Error('The wallet did not return a valid account.');
    return {provider,account:checked.address};
  }

  async function switchExecutionWallet() {
    if (walletIdentityBusy()) return;
    if (state.wallets.provider) return openWalletSetup();
    const provider = executionProvider();
    if (!provider?.request) throw new Error('Open Hookline in a browser with an EVM wallet.');
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    await connectExecutionWallet();
    setExecutionMessage('Wallet updated. A fresh quote is required.', 'success');
  }

  async function restoreExecutionWallet() {
    const provider = executionProvider();
    if (!provider || typeof provider.request !== 'function') return;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      const checked = validateAddress(accounts?.[0]);
      state.execution.account = checked.ok ? checked.address : null;
    } catch (_) {
      state.execution.account = null;
    }
    renderWalletIdentity();
    bindExecutionProvider(provider);
  }

  async function ensureExecutionChain(provider, chainId) {
    const config = EXECUTION_CHAINS[chainId];
    if (!config) throw new Error('Execution is not configured on this chain.');
    const current = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
    if (current !== config.chainId) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chainId }] });
      } catch (error) {
        if (Number(error?.code) !== 4902) throw error;
        await provider.request({ method: 'wallet_addEthereumChain', params: [config] });
      }
    }
    const verified = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
    if (verified !== config.chainId) throw new Error('Wallet chain switch did not complete.');
  }

  async function requestExecutionQuote() {
    if (state.execution.busy || hasPendingExecution() || state.wallets.controller?.isBusy()) return;
    setExecutionBusy(true);
    const submit = $('execution-submit');
    submit.disabled = true;
    submit.textContent = 'Quoting…';
    try {
      const module = await executionModule();
      const { provider, account } = state.execution.account
        ? { provider: executionProvider(), account: state.execution.account }
        : await connectExecutionWallet();
      if (!provider) throw new Error('Wallet provider unavailable.');
      const chainId = state.execution.item.chainId;
      await ensureExecutionChain(provider, chainId);
      if (state.execution.pendingSellPercent) await applyExecutionSellPercent(state.execution.pendingSellPercent);
      const [pair, capability] = await Promise.all([
        resolvedExecutionPair(),
        state.execution.capability ? Promise.resolve(state.execution.capability) : loadExecutionCapability(chainId),
      ]);
      if (capability.quote_review_enabled !== true || capability.fee_collection_enabled !== true) {
        throw new Error('Live fee-bound quotes are unavailable on this chain.');
      }
      const request = module.buildQuoteRequest({
        chainId,
        fromAddress: account,
        inputToken: pair.input,
        outputToken: pair.output,
        amount: $('execution-amount').value,
        slippageBps: executionSlippageBps(),
      });
      const context = executionQuoteContext();
      const response = await fetch('/api/execution/quote', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain_id: request.chainId,
          sell_token: request.inputAsset.address,
          buy_token: request.outputAsset.address,
          sell_amount: request.exactInputAmountBaseUnits,
          taker: request.fromAddress,
          slippage_bps: request.slippageBps,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.quote) throw new Error(String(payload?.error || 'Quote unavailable.').replaceAll('_', ' '));
      if (context !== executionQuoteContext()) throw new Error('Trade settings changed. Get a fresh quote.');
      state.execution.quote = payload.quote;
      state.execution.quoteContext = context;
      renderExecutionQuote(pair, payload.quote);
    } catch (error) {
      state.execution.quote = null;
      $('execution-quote').hidden = true;
      setExecutionMessage(error.message || 'Quote unavailable.', 'error');
    } finally {
      setExecutionBusy(false);
      if (!state.execution.quote) resetExecutionQuote();
    }
  }

  async function waitForWalletReceipt(provider, transactionHash) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
      if (receipt) {
        if (String(receipt.status).toLowerCase() !== '0x1') throw Object.assign(new Error('The transaction reverted. No successful fill.'),{revertedReceipt:receipt});
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('Transaction submitted. Confirmation is still pending.');
  }

  async function requestWalletConfirmation(provider, transaction) {
    const accounts=await provider.request({method:'eth_accounts'});
    if(!accounts?.some(value=>String(value).toLowerCase()===String(transaction.from).toLowerCase())) throw new Error('The selected account is no longer connected.');
    const chain=String(await provider.request({method:'eth_chainId'})).toLowerCase();
    if(chain!==EXECUTION_CHAINS[state.execution.item.chainId]?.chainId) throw new Error('Wallet chain changed. Review a fresh quote.');
    const dialog=$('execution-dialog'),wasOpen=dialog.open;
    if(wasOpen) dialog.close();
    try {
      const hash=await provider.request({method:'eth_sendTransaction',params:[transaction]});
      if(!/^0x[0-9a-f]{64}$/i.test(String(hash))) throw new Error('Wallet returned no valid transaction hash. Check its activity before trying again.');
      return hash;
    } finally {if(wasOpen&&!dialog.open)dialog.showModal();}
  }

  async function approveExecutionToken(pair, quote) {
    const provider = executionProvider();
    const spender = String(quote.allowance?.spender || '').toLowerCase();
    const amount = String(quote.allowance?.required_amount_base_units || '');
    if (!provider || !/^0x[0-9a-f]{40}$/.test(spender) || !/^\d+$/.test(amount) || pair.input.native) {
      throw new Error('Exact token approval is unavailable.');
    }
    const data = `0x095ea7b3${spender.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
    const hash = await requestWalletConfirmation(provider, {
      from: state.execution.account,
      to: pair.input.address,
      data,
      value: '0x0',
    });
    state.execution.pendingApprovalHash=hash;
    state.execution.pendingProvider=provider;
    setExecutionMessage('Approval submitted. Waiting for confirmation…', '');
    await waitForWalletReceipt(provider, hash);
    state.execution.pendingApprovalHash=null;
    state.execution.pendingProvider=null;
    state.execution.quote = null;
    return true;
  }

  async function submitExecutionTransaction(quote) {
    const provider = executionProvider();
    const transaction = quote.unsigned_transaction;
    const intent = quote.execution_intent;
    if (!provider || !transaction || String(transaction.from).toLowerCase() !== state.execution.account) {
      throw new Error('Reviewed transaction is not bound to this wallet.');
    }
    if (!/^hxi_[0-9a-f]{32}$/.test(String(intent?.intent_id || ''))
      || !Number.isFinite(Date.parse(String(intent?.expires_at || '')))
      || Date.parse(intent.expires_at) <= Date.now()) {
      throw new Error('This reviewed route expired. Request a fresh quote.');
    }
    const walletTransaction = {
      from: state.execution.account,
      to: transaction.to,
      data: transaction.data,
      value: decimalToHexQuantity(transaction.value),
      gas: decimalToHexQuantity(transaction.gas),
    };
    if (transaction.gas_price != null) walletTransaction.gasPrice = decimalToHexQuantity(transaction.gas_price);
    if (transaction.max_fee_per_gas != null) walletTransaction.maxFeePerGas = decimalToHexQuantity(transaction.max_fee_per_gas);
    if (transaction.max_priority_fee_per_gas != null) walletTransaction.maxPriorityFeePerGas = decimalToHexQuantity(transaction.max_priority_fee_per_gas);
    const hash = await requestWalletConfirmation(provider, walletTransaction);
    state.execution.submittedHash = hash;
    state.execution.pendingIntentId = intent.intent_id;
    setExecutionMessage(`Submitted ${shorten(hash, 10, 8)}. Waiting for confirmation…`, '');
    await waitForWalletReceipt(provider, hash);
    setExecutionMessage(`Confirmed onchain. Verifying Hookline receipt…`, '');
    await loadSubmittedExecutionReceipt(intent.intent_id, hash);
  }

  async function loadSubmittedExecutionReceipt(intentId, hash) {
    const response = await fetch('/api/execution/receipt', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_id: intentId, transaction_hash: hash }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.receipt) {
      throw new Error(String(payload?.error || 'Receipt verification failed.').replaceAll('_', ' '));
    }
    state.execution.receipt = payload.receipt;
    $('execution-receipt-hash').textContent = shorten(hash, 10, 8);
    $('execution-receipt-economics').textContent = `1.00% gross, 0.30% instant cashback, 0.70% effective fee. Block ${payload.receipt.block_number}.`;
    $('execution-receipt').hidden = false;
    setExecutionMessage(`Confirmed ${shorten(hash, 10, 8)}. Receipt evidence saved.`, 'success');
    $('execution-submit').disabled = true;
    $('execution-submit').textContent = 'Confirmed';
  }

  async function checkExecutionConfirmation() {
    if(state.execution.busy || !hasPendingExecution()) return;
    setExecutionBusy(true);$('execution-submit').disabled=true;
    try {
      if(state.execution.pendingApprovalHash) {
        const provider=state.execution.pendingProvider;
        await ensureExecutionChain(provider,state.execution.item.chainId);
        await waitForWalletReceipt(provider,state.execution.pendingApprovalHash);
        state.execution.pendingApprovalHash=null;state.execution.pendingProvider=null;
        resetExecutionQuote();setExecutionMessage('Approval confirmed. Request a fresh quote before trading.','success');
      } else await loadSubmittedExecutionReceipt(state.execution.pendingIntentId,state.execution.submittedHash);
    } catch(error) {
      if(error.revertedReceipt) {
        state.execution.pendingApprovalHash=null;state.execution.pendingProvider=null;
        state.execution.receipt={reverted:true};resetExecutionQuote();
      }
      setExecutionMessage(error.message || 'Confirmation is not available yet. Do not resubmit.','error');
    } finally {
      setExecutionBusy(false);
      if(hasPendingExecution() || !state.execution.quote) resetExecutionQuote();
      else if(!state.execution.receipt) resetExecutionQuote();
    }
  }

  async function advanceExecution() {
    if (state.execution.busy || state.accountController?.isBusy() || state.wallets.controller?.isBusy()) return;
    if (hasPendingExecution()) return checkExecutionConfirmation();
    const quote = state.execution.quote;
    if (!quote) return requestExecutionQuote();
    try { if (state.execution.quoteContext !== executionQuoteContext()) throw new Error('Trade settings changed. Get a fresh quote.'); }
    catch (error) { resetExecutionQuote(); setExecutionMessage(error.message, 'error'); return; }
    if (state.execution.capability?.cashback_settlement_enabled !== true
      || state.execution.capability?.cashback_mode !== 'instant_fee_rebate'
      || Number(state.execution.capability?.effective_fee_bps) !== 70) return;
    const hardBlockers = Array.isArray(quote.blockers)
      ? quote.blockers.filter((blocker) => blocker !== 'allowance_required')
      : [];
    if (hardBlockers.length) {
      setExecutionMessage(hardBlockers.join(', ').replaceAll('_', ' '), 'error');
      return;
    }
    const provider = executionProvider();
    if (!provider) {
      setExecutionMessage('Wallet provider unavailable.', 'error');
      return;
    }
    setExecutionBusy(true);
    $('execution-submit').disabled = true;
    let approved = false;
    try {
      await ensureExecutionChain(provider, state.execution.item.chainId);
      const pair = await resolvedExecutionPair();
      if (state.execution.quoteContext !== executionQuoteContext()) throw new Error('Trade settings changed. Get a fresh quote.');
      if (quote.allowance?.state === 'approval_required') approved = await approveExecutionToken(pair, quote);
      else await submitExecutionTransaction(quote);
    } catch (error) {
      if(error.revertedReceipt) {
        state.execution.pendingApprovalHash=null;state.execution.pendingProvider=null;
        state.execution.receipt={reverted:true};resetExecutionQuote();
        setExecutionMessage(error.message,'error');
      } else if (hasPendingExecution()) {
        setExecutionMessage(`Transaction ${shorten(state.execution.submittedHash || state.execution.pendingApprovalHash, 10, 8)} was submitted. Check confirmation; do not resubmit.`, 'error');
        $('execution-submit').textContent = 'Check confirmation';
      } else {
        setExecutionMessage(error.message || 'Wallet action failed.', 'error');
        $('execution-submit').disabled = false;
      }
    } finally {
      setExecutionBusy(false);
      if(hasPendingExecution() || !state.execution.quote) resetExecutionQuote();
    }
    if (approved) await requestExecutionQuote();
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
    state.accountController?.localChanged();
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
    state.pendingLocalReads++;
    try {
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
    } finally {state.pendingLocalReads--;}
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

  function normalizeBoardProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanString(raw.name, 120);
    if (!name) return null;
    return {
      sourceId: cleanString(raw.sourceId, 120) || null,
      hookId: cleanString(raw.hookId, 100).toLowerCase() || null,
      name,
      description: cleanString(raw.description, 800),
      type: cleanString(raw.type, 200),
      dex: cleanString(raw.dex, 120),
      stage: cleanString(raw.stage, 120),
      website: cleanString(raw.website, 500) || null,
      x: cleanString(raw.x, 500) || null,
      provenance: cleanString(raw.provenance, 80) || 'community record',
    };
  }

  function normalizeVerifiedContract(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanString(raw.name, 160);
    if (!name) return null;
    return {
      name,
      fullyQualifiedName: cleanString(raw.fullyQualifiedName, 500) || null,
      language: cleanString(raw.language, 40) || null,
      compiler: cleanString(raw.compiler, 40) || null,
      compilerVersion: cleanString(raw.compilerVersion, 100) || null,
      verifiedAt: cleanString(raw.verifiedAt, 80) || null,
      provenance: cleanString(raw.provenance, 80) || 'Sourcify verified source',
    };
  }

  function normalizeBoardSnapshot(raw) {
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.hooks) || !Array.isArray(raw.projects)) return null;
    const projects = raw.projects.map(normalizeBoardProject).filter(Boolean);
    const byHook = new Map(projects.filter((project) => project.hookId).map((project) => [project.hookId, project]));
    const hooks = raw.hooks.map((hook) => {
      const chainId = Number(hook && hook.chainId);
      const checked = validateAddress(hook && hook.address);
      if (!Number.isSafeInteger(chainId) || !checked.ok) return null;
      const id = `${chainId}_${checked.address}`;
      const project = normalizeBoardProject(hook.project) || byHook.get(id) || null;
      const verifiedContract = normalizeVerifiedContract(hook.verifiedContract);
      const permissions = permissionProfiles(checked.address);
      return {
        kind: 'hook', id, chainId, chainName: cleanString(hook.chainName, 100) || `Chain ${chainId}`,
        address: checked.address, indexedAddress: cleanString(hook.address, 42) || checked.address,
        numberOfPools: Math.max(0, Number(hook.numberOfPools) || 0),
        numberOfSwaps: Math.max(0, Number(hook.numberOfSwaps) || 0),
        liveInspection: SUPPORTED_CHAINS.includes(chainId), project, verifiedContract, permissions,
      };
    }).filter(Boolean);
    const linked = new Set(hooks.filter((hook) => hook.project).map((hook) => hook.project.sourceId).filter(Boolean));
    const directory = projects.filter((project) => !project.hookId || !linked.has(project.sourceId)).map((project) => ({
      kind: 'project', id: `project:${project.sourceId || project.name.toLowerCase()}`, chainId: null,
      chainName: 'Unlinked', address: null, numberOfPools: null, numberOfSwaps: null,
      liveInspection: false, project, verifiedContract: null, permissions: { enabled: [], profiles: [] },
    }));
    const generatedAt = Date.parse(raw.generatedAt);
    return {
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : null,
      coverage: raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {},
      chains: Array.isArray(raw.chains) ? raw.chains : [], projects, hooks, items: hooks.concat(directory),
    };
  }

  function normalizeRuntimeFamilies(raw) {
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.deployments) || !Array.isArray(raw.families)) return null;
    const deployments = raw.deployments.filter((row) => (
      row && typeof row.id === 'string' && /^[0-9]+_0x[0-9a-fA-F]{40}$/.test(row.id)
      && typeof row.fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(row.fingerprint)
    )).map((row) => ({
      id: row.id.toLowerCase(),
      chainId: Number(row.chainId),
      address: cleanString(row.address, 42).toLowerCase(),
      fingerprint: row.fingerprint.toLowerCase(),
      codeByteLength: Math.max(0, Number(row.codeByteLength) || 0),
    }));
    const families = raw.families.filter((family) => (
      family && typeof family.runtimeFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(family.runtimeFingerprint)
    )).map((family) => ({
      fingerprint: family.runtimeFingerprint.toLowerCase(),
      codeByteLength: Math.max(0, Number(family.codeByteLength) || 0),
      deploymentCount: Math.max(1, Number(family.deploymentCount) || 1),
      chainIds: Array.isArray(family.chainIds) ? family.chainIds.map(Number).filter(Number.isSafeInteger) : [],
      deployments: Array.isArray(family.deployments) ? family.deployments.map((id) => String(id).toLowerCase()).filter((id) => /^[0-9]+_0x[0-9a-f]{40}$/.test(id)) : [],
      representativeName: cleanString(family.representativeName, 160) || null,
    }));
    const generatedAt = Date.parse(raw.generatedAt);
    return {
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : null,
      coverage: raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {},
      deployments,
      families,
      deploymentById: new Map(deployments.map((row) => [row.id, row])),
      familyByFingerprint: new Map(families.map((family) => [family.fingerprint, family])),
    };
  }

  function attachRuntimeFamilies(board, runtime) {
    if (!board || !runtime) return;
    board.hooks.forEach((item) => {
      const deployment = runtime.deploymentById.get(item.id);
      const family = deployment && runtime.familyByFingerprint.get(deployment.fingerprint);
      item.runtime = deployment && family ? { ...deployment, ...family } : null;
    });
  }

  function boardItemName(item) {
    return item.project?.name || item.verifiedContract?.name || 'Unlabeled hook';
  }

  function boardProfileLabels(item) {
    if (item.kind === 'project') {
      return item.project.type ? item.project.type.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 3) : ['project record'];
    }
    return item.permissions.profiles.length ? item.permissions.profiles : ['no callbacks'];
  }

  function boardVelocity(item) {
    if (item.tokenContext) {
      const transactions = Math.max(0, Number(item.tokenContext.transactions) || 0);
      const liquidity = Math.max(0, Number(item.tokenContext.liquidityUsd) || 0);
      return Math.log1p(transactions) * (1 + Math.log10(1 + liquidity));
    }
    const swaps = Math.max(0, Number(item.numberOfSwaps) || 0);
    const pools = Math.max(1, Number(item.numberOfPools) || 1);
    return Math.log1p(swaps) * (1 + Math.log1p(pools)) / Math.sqrt(pools);
  }

  function filteredBoardItems() {
    if (!state.board) return [];
    const query = $('board-search').value.trim().toLowerCase();
    const chain = $('board-chain').value;
    const profile = $('board-profile').value;
    const sort = $('board-sort').value;
    const source = state.boardMode === 'token'
      ? state.tokenRelationships.map((relationship) => {
          const item = state.board.items.find((candidate) => candidate.id === relationship.hookId);
          return item ? { ...item, tokenContext: relationship } : null;
        }).filter(Boolean)
      : state.board.items;
    const result = source.filter((item) => {
      if (chain !== 'all' && String(item.chainId) !== chain) return false;
      if (!matchPermissionPattern(item, profile)) return false;
      if (state.boardProjectsOnly && !item.project && !item.verifiedContract) return false;
      if (state.boardMode === 'token' || !query) return true;
      const fields = [boardItemName(item), capabilitySentence(item), item.chainName, item.address, item.project?.type, item.project?.stage, item.verifiedContract?.fullyQualifiedName, item.runtime?.fingerprint, ...boardProfileLabels(item)];
      return fields.some((value) => String(value || '').toLowerCase().includes(query));
    });
    result.sort((a, b) => {
      if (state.boardMode === 'token') {
        if (sort === 'token') return String(a.tokenContext?.pairLabel || '').localeCompare(String(b.tokenContext?.pairLabel || ''));
        if (sort === 'activity') return (b.tokenContext?.transactions ?? -1) - (a.tokenContext?.transactions ?? -1) || (b.tokenContext?.liquidityUsd ?? -1) - (a.tokenContext?.liquidityUsd ?? -1);
        if (sort === 'velocity') return boardVelocity(b) - boardVelocity(a);
        return (b.tokenContext?.liquidityUsd ?? -1) - (a.tokenContext?.liquidityUsd ?? -1) || (b.tokenContext?.transactions ?? -1) - (a.tokenContext?.transactions ?? -1);
      }
      if (sort === 'name') return boardItemName(a).localeCompare(boardItemName(b));
      if (sort === 'family') return (b.runtime?.deploymentCount ?? 0) - (a.runtime?.deploymentCount ?? 0) || boardVelocity(b) - boardVelocity(a);
      if (sort === 'pools') return (b.numberOfPools ?? -1) - (a.numberOfPools ?? -1) || (b.numberOfSwaps ?? -1) - (a.numberOfSwaps ?? -1);
      if (sort === 'velocity') return boardVelocity(b) - boardVelocity(a);
      return (b.numberOfSwaps ?? -1) - (a.numberOfSwaps ?? -1) || (b.numberOfPools ?? -1) - (a.numberOfPools ?? -1);
    });
    return result;
  }

  function replaceSortOptions(options) {
    const select = $('board-sort');
    select.replaceChildren();
    options.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
  }

  async function loadTokenRelationships(query) {
    const trimmed = String(query || '').trim();
    if (trimmed.length === 1) {
      state.tokenRelationships = [];
      state.tokenLoading = false;
      renderBoard();
      return;
    }
    const requestId = ++state.tokenRequest;
    state.tokenLoading = true;
    renderBoard();
    try {
      const params = new URLSearchParams();
      if (trimmed) params.set('q', trimmed);
      params.set('v', '1');
      const response = await fetch(`/api/token-hooks${params.size ? `?${params}` : ''}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.relationships)) throw new Error('Token lookup failed.');
      if (requestId !== state.tokenRequest) return;
      state.tokenRelationships = payload.relationships.filter((entry) => (
        entry && typeof entry.hookId === 'string' && typeof entry.poolId === 'string'
      ));
    } catch (error) {
      if (requestId !== state.tokenRequest) return;
      state.tokenRelationships = [];
      toast(error.message, 'alert');
    } finally {
      if (requestId === state.tokenRequest) {
        state.tokenLoading = false;
        state.boardVisible = BOARD_PAGE_SIZE;
        renderBoard();
      }
    }
  }

  function setBoardMode(mode) {
    if (!['hook', 'token'].includes(mode) || state.boardMode === mode) return;
    state.boardMode = mode;
    state.boardVisible = BOARD_PAGE_SIZE;
    $('board-mode-hook').setAttribute('aria-pressed', String(mode === 'hook'));
    $('board-mode-token').setAttribute('aria-pressed', String(mode === 'token'));
    const search = $('board-search');
    search.value = '';
    if (mode === 'token') {
      search.placeholder = 'Search token symbol, name, or address…';
      search.setAttribute('aria-label', 'Search tokens and reveal their hooks');
      $('board-pools-heading').textContent = 'Pools';
      $('board-swaps-heading').textContent = 'Transactions';
      replaceSortOptions([['velocity', 'Velocity'], ['liquidity', 'Most liquidity'], ['activity', 'Most transactions'], ['token', 'Token name']]);
      void loadTokenRelationships('');
    } else {
      search.placeholder = 'Search name, address, chain, behavior…';
      search.setAttribute('aria-label', 'Search hook board');
      $('board-pools-heading').textContent = 'Pools';
      $('board-swaps-heading').textContent = 'Swaps';
      replaceSortOptions([['velocity', 'Velocity'], ['swaps', 'Most swaps'], ['pools', 'Most pools'], ['family', 'Largest runtime family'], ['name', 'Project name']]);
      renderBoard();
    }
  }

  function makeCapabilityChips(item) {
    const container = makeElement('div', 'capability-stack');
    boardProfileLabels(item).forEach((label) => {
      const className = item.permissions.profiles.includes(label) ? `capability-chip ${label}` : 'capability-chip';
      container.append(makeElement('span', className, label));
    });
    return container;
  }

  function renderBoardStats() {
    if (!state.board) return;
    const values = [
      [state.board.coverage.hookCount ?? state.board.hooks.length, 'community discovery'],
      [state.board.coverage.chainCount ?? state.board.chains.length, 'cross-chain coverage'],
      [state.board.coverage.totalPools ?? 0, 'indexed aggregate'],
      [state.board.coverage.totalSwaps ?? 0, 'indexed aggregate'],
    ];
    $('board-stats').querySelectorAll(':scope > div').forEach((node, index) => {
      const value = Number(values[index][0]);
      node.querySelector('strong').textContent = formatNumber(value);
      node.querySelector('small').textContent = values[index][1];
    });
    $('board-updated').textContent = state.board.generatedAt ? relativeTime(state.board.generatedAt) : 'timestamp unavailable';
    if (state.board.generatedAt) $('board-updated').dateTime = new Date(state.board.generatedAt).toISOString();
  }

  function populateBoardChains() {
    const select = $('board-chain');
    while (select.options.length > 1) select.remove(1);
    state.board.chains.forEach((chain) => {
      const option = document.createElement('option');
      option.value = String(chain.chainId);
      option.textContent = `${cleanString(chain.name, 100) || `Chain ${chain.chainId}`} (${formatNumber(Number(chain.hookCount) || 0)})`;
      select.append(option);
    });
  }

  function renderBoard() {
    const body = $('hook-board-body');
    body.replaceChildren();
    if (!state.board) return;
    const filtered = filteredBoardItems();
    const visible = filtered.slice(0, state.boardVisible);
    $('board-result-count').textContent = state.boardMode === 'token'
      ? state.tokenLoading
        ? 'Resolving token, hook relationships…'
        : `${formatNumber(filtered.length)} token pools · select one to reveal its hook and sibling markets`
      : `${formatNumber(filtered.length)} results · ${formatNumber(state.board.hooks.length)} hooks · ${formatNumber(state.runtimeFamilies?.coverage?.repeatedFamilies || 0)} repeated runtimes · ${formatNumber(state.board.coverage?.verifiedIdentityCount || 0)} verified titles · ${formatNumber(state.board.projects.length)} project records`;
    visible.forEach((item, index) => {
      const token = item.tokenContext;
      const row = document.createElement('tr');
      row.dataset.id = item.id;
      row.tabIndex = 0;
      row.classList.toggle('selected', item.id === state.boardSelectedId);
      row.setAttribute('aria-label', token ? `Open ${token.pairLabel} through ${boardItemName(item)}` : `Open ${boardItemName(item)} profile`);
      const identity = makeElement('div', token ? 'hook-identity token' : 'hook-identity');
      identity.append(
        makeElement('strong', '', token?.pairLabel || boardItemName(item)),
        makeElement('code', '', token ? `${boardItemName(item)}, ${shorten(item.address, 8, 6)}` : item.address ? shorten(item.address, 10, 8) : 'project record · no indexed address'),
      );
      if (!token && item.runtime?.deploymentCount > 1) {
        identity.append(makeElement(
          'span',
          'runtime-family-chip repeated',
          `family ${item.runtime.deploymentCount} · ${item.runtime.chainIds.length} chain${item.runtime.chainIds.length === 1 ? '' : 's'}`,
        ));
      }
      const identityCell = document.createElement('td');
      identityCell.append(identity);
      const chainCell = makeElement('td', 'chain-cell');
      const chainSpan = makeElement('span', '', item.chainName);
      chainSpan.style.setProperty('--chain-color', CHAIN_COLORS[item.chainId] || '#66727e');
      chainCell.append(chainSpan);
      const capabilities = makeElement('td', 'capability-cell');
      capabilities.append(makeElement('p', 'capability-sentence', capabilitySentence(item)), makeCapabilityChips(item));
      const coverage = makeElement('span', `coverage-chip${item.liveInspection ? ' live' : ''}`, item.liveInspection ? 'live RPC' : item.kind === 'project' ? 'directory' : 'index only');
      const coverageCell = document.createElement('td');
      coverageCell.append(coverage);
      row.append(
        makeElement('td', 'hook-rank', index + 1), identityCell, chainCell, capabilities,
        makeElement('td', 'number', token ? '1' : item.numberOfPools == null ? '—' : compactNumber(item.numberOfPools)),
        makeElement('td', 'number', token ? compactNumber(Number(token.transactions) || 0) : item.numberOfSwaps == null ? '—' : compactNumber(item.numberOfSwaps)), coverageCell,
      );
      const select = () => {
        state.boardSelectedId = item.id;
        if (item.kind === 'hook') history.replaceState(null, '', `#/board/${item.chainId}/${item.address}`);
        renderBoard();
        renderBoardProfile();
        inspectProfileIfNeeded();
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      body.append(row);
    });
    $('board-empty').hidden = filtered.length !== 0 || state.tokenLoading;
    $('board-empty').textContent = state.boardMode === 'token'
      ? $('board-search').value.trim().length === 1 ? 'Type at least 2 characters.' : 'No indexed hook pools match this token.'
      : 'No hooks match these filters.';
    $('board-more').hidden = filtered.length <= state.boardVisible;
    $('board-more').textContent = `Load ${Math.min(BOARD_PAGE_SIZE, filtered.length - state.boardVisible)} more rows`;
  }

  function selectedBoardItem() {
    return state.board?.items.find((item) => item.id === state.boardSelectedId) || null;
  }

  function setProfileRecord(id, value) {
    $(id).textContent = value || '—';
  }

  function safeProfileLink(url, label) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      const link = makeElement('a', '', label);
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch (_) { return null; }
  }

  function renderBoardProfile() {
    const item = selectedBoardItem();
    document.body.classList.toggle('board-profile-open', Boolean(item));
    const empty = $('hook-board-detail').querySelector('.hook-profile-empty');
    $('hook-profile-content').hidden = !item;
    empty.hidden = Boolean(item);
    if (!item) return;
    const persistedMarkets = marketCacheEntry(item, false);
    const priorEvidence = state.boardEvidence.get(item.id);
    if (persistedMarkets && !Array.isArray(priorEvidence?.markets)) {
      state.boardEvidence.set(item.id, {
        ...priorEvidence,
        markets: persistedMarkets.markets,
        marketObservedAt: persistedMarkets.observedAt,
      });
    }
    const project = item.project;
    $('hook-profile-chain').textContent = item.chainName;
    $('hook-profile-source').textContent = project?.provenance || item.verifiedContract?.provenance || 'indexed identity';
    $('hook-profile-title').textContent = boardItemName(item);
    $('hook-profile-address').textContent = item.address || 'No deployment address linked';
    $('hook-profile-copy').hidden = !item.address;
    $('hook-profile-capability').textContent = capabilitySentence(item);
    const description = $('hook-profile-description');
    description.textContent = project?.description || '';
    description.hidden = !description.textContent;
    renderHookProjectLinks(item);
    $('hook-profile-pools').textContent = item.numberOfPools == null ? '—' : formatNumber(item.numberOfPools);
    $('hook-profile-swaps').textContent = item.numberOfSwaps == null ? '—' : formatNumber(item.numberOfSwaps);
    $('hook-profile-mask').textContent = item.address ? `0x${decodePermissions(item.address).value.toString(16).padStart(4, '0')}` : '—';
    const permissions = $('hook-profile-permissions');
    permissions.replaceChildren();
    if (item.permissions.profiles.length) {
      const labels = { swap: 'Swap', liquidity: 'Liquidity', initialize: 'Initialize', donate: 'Donate', delta: 'Return delta' };
      item.permissions.profiles.forEach((name) => permissions.append(makeElement('span', '', labels[name] || name)));
    } else {
      permissions.append(makeElement('span', 'none', item.address ? 'none encoded' : '—'));
    }
    $('hook-profile-callback-count').textContent = item.address ? `${item.permissions.enabled.length} / 14 bits` : '';
    renderBoardMarkets(item);
    renderBoardTape(item);
    renderRuntimeFamily(item);
    renderBoardLiveEvidence(item);
    $('hook-profile-project').hidden = !project;
    if (project) {
      setProfileRecord('hook-profile-type', project.type);
      setProfileRecord('hook-profile-stage', project.stage);
      setProfileRecord('hook-profile-dex', project.dex);
      const links = $('hook-profile-links');
      links.replaceChildren();
      const website = project.website && safeProfileLink(project.website, 'Website');
      const x = project.x && safeProfileLink(project.x, 'X');
      if (website) links.append(website);
      if (x) links.append(x);
    }
    const inspectable = item.kind === 'hook' && Boolean(item.address);
    const cached = state.boardEvidence.get(item.id);
    $('hook-profile-inspect').disabled = !inspectable;
    $('hook-profile-inspect').textContent = inspectable && (cached?.result || cached?.markets) ? 'Refresh' : 'Inspect';
    $('hook-profile-watch').disabled = !(inspectable && item.liveInspection);
    $('hook-profile-share').disabled = item.kind !== 'hook';
    const explorer = $('hook-profile-explorer');
    const explorerUrl = item.address ? explorerAddressUrl(item.chainId, item.address) : null;
    explorer.hidden = !explorerUrl;
    if (explorerUrl) explorer.href = explorerUrl;
    const telegramStart = item.address
      ? `hook_${item.chainId}_${item.address.slice(2)}`
      : '';
    $('hook-profile-telegram').href = telegramStart
      ? `https://t.me/HooklineTradeBot?start=${telegramStart}`
      : 'https://t.me/HooklineTradeBot';
    $('hook-profile-alert').href = item.address
      ? `https://t.me/HooklineTradeBot?start=alert_${item.chainId}_${item.address.slice(2)}`
      : 'https://t.me/HooklineTradeBot';
    $('hook-profile-boundary').textContent = item.kind === 'project'
      ? 'Directory record · deployment not linked'
      : item.liveInspection ? 'Counts · v4.xyz snapshot   Contract · live RPC' : 'Counts · v4.xyz snapshot   Contract RPC · unavailable';
  }

  // PoolKey.fee uses hundredths of a basis point. EXACTLY 0x800000 is
  // the dynamic sentinel, not 838.8608%. Do not strip flags into a fee:
  // 0x400000 is a beforeSwap override flag, not a valid PoolKey fee tier.
  // https://github.com/Uniswap/v4-core/blob/main/src/libraries/LPFeeLibrary.sol
  function poolFeePresentation(market) {
    const missing = { kind: 'unavailable', label: 'Unavailable', rawUnits: null, detail: 'No pool fee tier is available.' };
    const invalid = { kind: 'invalid', label: 'Invalid', rawUnits: null, detail: 'The indexed fee tier is not a valid v4 PoolKey fee.' };
    const dynamic = { kind: 'dynamic', label: 'Dynamic', rawUnits: 0x800000,
      detail: 'Dynamic-fee PoolKey flag (0x800000). The current LP fee has not been measured; this flag is not a fee percentage.' };
    if (market?.feeMode === 'dynamic') return dynamic;
    if (market?.feeMode === 'invalid') return invalid;
    if (market?.feeMode === 'unavailable') return missing;
    const raw = market?.poolKey?.fee ?? market?.poolFee?.rawUnits ?? market?.advertisedFeeUnits ?? market?.feeTier;
    let units;
    if (raw != null) {
      if ((typeof raw !== 'string' && typeof raw !== 'number') || String(raw).length > 16 || !/^(?:\d+|0x[0-9a-f]+)$/i.test(String(raw))) return invalid;
      const value = BigInt(String(raw));
      if (value > 0xffffffn) return invalid;
      units = Number(value);
    } else {
      // Compatibility for the current API and cached index rows, which exposed
      // the tier as a percent parsed from the pool's source name.
      const suffix = String(market?.poolName || '').match(/-\s*([+-]?[0-9]+(?:\.[0-9]+)?)%\s*$/);
      const percent = market?.advertisedFeePercent ?? suffix?.[1];
      if (percent == null) return missing;
      if ((typeof percent !== 'string' && typeof percent !== 'number') || String(percent).length > 16 || !/^\d+(?:\.\d{1,4})?$/.test(String(percent))) return invalid;
      const [whole, fraction = ''] = String(percent).split('.');
      const value = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
      if (value > 0xffffffn) return invalid;
      units = Number(value);
    }
    if (units === 0x800000) return market?.feeMode === 'static' ? invalid : dynamic;
    if (units > 1000000) return invalid;
    const padded = String(units).padStart(5, '0');
    const fraction = padded.slice(-4).replace(/0+$/, '');
    const percent = `${Number(padded.slice(0, -4))}${fraction ? `.${fraction}` : ''}`;
    return { kind: 'static', label: `${percent}% advertised`, rawUnits: units,
      detail: 'Index-reported static LP fee, not measured swap cost. Separate hook charges are not included.' };
  }

  function poolDisplayName(value) {
    // Fee metadata is rendered separately with PoolKey-aware validation. Do
    // not repeat a source's incorrectly formatted sentinel in the card title.
    return cleanString(value, 140).replace(/\s+-\s*[+-]?[0-9]+(?:\.[0-9]+)?%\s*$/, '');
  }

  function renderBoardMarkets(item) {
    const section = $('hook-profile-markets');
    const list = $('hook-profile-market-list');
    const status = $('hook-profile-market-status');
    list.replaceChildren();
    const cached = state.boardEvidence.get(item.id);
    const markets = Array.isArray(cached?.markets) ? cached.markets.slice(0, 4) : [];
    section.hidden = markets.length === 0;
    if (!markets.length) return;
    const hasLiveMarkets = markets.some((market) => market.priceUsd != null && Number.isFinite(Number(market.priceUsd)));
    const age = Number(cached?.marketObservedAt);
    status.textContent = `${markets.length} shown · ${hasLiveMarkets ? 'DexScreener' : 'pool index'}${Number.isFinite(age) ? ` · ${relativeTime(age)}` : ''}`;
    markets.forEach((market) => {
      const card = makeElement('article', 'profile-market-card');
      const head = makeElement('div', 'market-card-head');
      const identity = makeElement('div', 'market-identity');
      identity.append(
        makeElement('strong', '', market.baseToken?.symbol ? `$${market.baseToken.symbol}` : poolDisplayName(market.poolName)),
        makeElement('span', '', market.baseToken?.name || poolDisplayName(market.poolName) || 'Token market'),
      );
      const change = finiteNumberOrNull(market.priceChange24h);
      const changeNode = makeElement('b', change != null ? (change > 0 ? 'positive' : change < 0 ? 'negative' : '') : '', change != null ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '—');
      head.append(identity, changeNode);
      const pair = makeElement('p', 'market-pair', `${market.baseToken?.symbol || '?'} / ${market.quoteToken?.symbol || '?'} · ${market.dexLabel || 'DEX'}`);
      const stats = makeElement('div', 'market-stats');
      const advertisedFee = poolFeePresentation(market);
      [
        ['PRICE', formatUsd(market.priceUsd, false)],
        ['MKT CAP', formatUsd(market.marketCap, true)],
        ['LIQ', formatUsd(market.liquidityUsd, true)],
        ['VOL 24H', formatUsd(market.volume24h, true)],
        ['POOL FEE', advertisedFee.label],
      ].forEach(([label, value]) => {
        const stat = makeElement('div', '');
        if (label === 'POOL FEE') { stat.title = advertisedFee.detail; stat.dataset.feeKind = advertisedFee.kind; }
        stat.append(makeElement('span', '', label), makeElement('strong', '', value));
        stats.append(stat);
      });
      const links = makeElement('div', 'market-links');
      const chart = safeProfileLink(market.chartUrl, 'Chart');
      const website = safeProfileLink(market.website, 'Website');
      const x = safeProfileLink(market.x, 'X');
      if (chart) links.append(chart);
      if (website) links.append(website);
      if (x) links.append(x);
      if (executionMarketReady(item, market)) {
        const trade = makeElement('button', 'market-trade', 'Trade');
        trade.type = 'button';
        trade.addEventListener('click', () => openExecutionDialog(item, market));
        links.append(trade);
      }
      card.append(head, pair, stats, links);
      list.append(card);
    });
  }

  function renderBoardTape(item) {
    const section=$('hook-profile-tape'),list=$('hook-profile-tape-list'),summary=$('hook-profile-tape-summary'),status=$('hook-profile-tape-status');
    list.replaceChildren();summary.replaceChildren();
    const cached=state.boardEvidence.get(item.id),pools=Array.isArray(cached?.tapePools)?cached.tapePools.slice(0,4):[],activity=cached?.tapeActivity;
    const measured=Number(activity?.summary?.swaps || 0);
    section.hidden=item.chainId!==8453 || (!pools.length && !measured);
    if(section.hidden) return;
    $('hook-profile-tape-open').href=`#/tape/swaps/8453/${item.address}`;
    $('hook-profile-tape-open').textContent='Open swap tape';
    status.textContent=measured?`${formatNumber(measured)} swaps${activity?.window?.complete?'':' · partial window'}`:`${pools.length} pool births`;
    if(measured) {
      const fee=activity.summary.poolManagerFee || {},min=Number(fee.minPercent),max=Number(fee.maxPercent);
      const feeText=Number.isFinite(min)&&Number.isFinite(max)?(min===max?`${min.toLocaleString(undefined,{maximumFractionDigits:4})}%`:`${min.toLocaleString(undefined,{maximumFractionDigits:4})}% to ${max.toLocaleString(undefined,{maximumFractionDigits:4})}%`):'Unavailable';
      const cells=[['SWAPS',formatNumber(measured)],['ACTIVE POOLS',formatNumber(Number(activity.summary.pools || 0))],['REPORTED FEE',feeText],['BLOCKS',`${formatNumber(Number(activity.window.fromBlock))} to ${formatNumber(Number(activity.window.toBlock))}`]];
      cells.forEach(([label,value])=>{const cell=document.createElement('div');cell.append(makeElement('span','',label),makeElement('strong','',value));summary.append(cell);});
    }
    pools.forEach((pool)=>{
      const card=makeElement('article','profile-tape-row');
      const identity=makeElement('div','');
      const code=makeElement('code','',tapeAddress(pool.poolId,10,8));code.title=pool.poolId;
      identity.append(makeElement('span','','Pool'),code);
      const facts=makeElement('div','');
      facts.append(makeElement('span','',tapeFee(pool)),makeElement('span','',`Block ${formatNumber(Number(pool.blockNumber))}`));
      const tx=tapeLink(`https://basescan.org/tx/${pool.transactionHash}`,'Source tx','');tx.target='_blank';tx.rel='noopener noreferrer';
      card.append(identity,facts,tx);list.append(card);
    });
  }

  function renderRuntimeFamily(item) {
    const section = $('hook-profile-runtime');
    const status = $('hook-profile-runtime-status');
    const hash = $('hook-profile-runtime-hash');
    const summary = $('hook-profile-runtime-summary');
    const members = $('hook-profile-runtime-members');
    members.replaceChildren();
    const runtime = item.runtime;
    section.hidden = !runtime;
    if (!runtime) return;
    const chainCount = runtime.chainIds.length;
    status.textContent = `${runtime.deploymentCount} deployment${runtime.deploymentCount === 1 ? '' : 's'} · ${chainCount} chain${chainCount === 1 ? '' : 's'}`;
    hash.textContent = runtime.fingerprint;
    hash.title = runtime.fingerprint;
    summary.textContent = runtime.deploymentCount > 1
      ? `Identical deployed bytecode appears at ${runtime.deploymentCount} indexed addresses.`
      : 'No other indexed deployment shares this runtime bytecode.';
    runtime.deployments
      .filter((id) => id !== item.id)
      .map((id) => state.board?.items.find((candidate) => candidate.id === id))
      .filter(Boolean)
      .slice(0, 6)
      .forEach((sibling) => {
        const link = makeElement('a', '', `${boardItemName(sibling)}, ${sibling.chainName}`);
        link.href = `#/board/${sibling.chainId}/${sibling.address}`;
        members.append(link);
      });
    members.hidden = members.childElementCount === 0;
  }

  function renderBoardLiveEvidence(item) {
    const grid = $('hook-profile-live-grid');
    const status = $('hook-profile-live-status');
    const note = $('hook-profile-live-note');
    grid.replaceChildren();
    note.hidden = true;
    note.textContent = '';
    const cached = state.boardEvidence.get(item.id);
    if (!item.liveInspection || !item.address) {
      status.textContent = 'unavailable';
      return;
    }
    if (!cached) {
      status.textContent = 'not loaded';
      return;
    }
    if (cached.error) {
      status.textContent = 'failed';
      note.textContent = cleanString(cached.error, 140) || 'RPC read failed.';
      note.hidden = false;
      return;
    }
    if (!cached.result) {
      status.textContent = 'not loaded';
      return;
    }
    const { evidence, observation } = cached.result;
    const liveFingerprint = fingerprintOf(evidence);
    const values = [
      ['Bytecode', `${formatNumber(evidence.codeByteLength)} bytes`],
      ['owner()', evidence.owner ? shorten(evidence.owner, 9, 7) : evidence.ownerProbeStatus === 'reverted' ? 'reverted' : 'not returned'],
      ['Block', observation.block == null ? '—' : formatNumber(observation.block)],
      ['RPC', formatLatency(evidence.latencyMs)],
      ['Runtime hash', liveFingerprint || '—'],
    ];
    values.forEach(([label, value]) => {
      const row = makeElement('div', 'profile-live-row');
      const code = makeElement('code', '', value);
      code.title = value;
      row.append(makeElement('span', '', label), code);
      grid.append(row);
    });
    status.textContent = new Date(observation.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (item.runtime?.fingerprint && liveFingerprint && item.runtime.fingerprint !== liveFingerprint) {
      status.textContent = 'runtime changed';
      note.textContent = 'Live bytecode no longer matches the indexed runtime family.';
      note.hidden = false;
    }
  }

  async function readHookMarkets(item, force) {
    const persisted = !force && marketCacheEntry(item, true);
    if (persisted) return persisted.markets;
    const params = new URLSearchParams({
      chainId: String(item.chainId),
      address: item.indexedAddress || item.address,
      v: MARKET_RESOLVER_VERSION,
    });
    const response = await fetch(`/api/v3/hook-markets?${params}`, {
      headers: { Accept: 'application/json' },
      cache: force ? 'no-store' : 'default',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !Array.isArray(payload.markets)) throw new Error('Market lookup failed.');
    let markets = payload.markets;
    const dexSlug = DEXSCREENER_CHAIN_SLUGS[item.chainId];
    const pairIds = markets.map((market) => cleanString(market.pairAddress, 70)).filter((value) => /^0x[0-9a-fA-F]{64}$/.test(value));
    if (dexSlug && pairIds.length && !markets.every((market) => market.priceUsd != null && Number.isFinite(Number(market.priceUsd)))) try {
      const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${dexSlug}/${pairIds.join(',')}`, { headers: { Accept: 'application/json' } });
      if (dexResponse.ok) {
        const dexPayload = await dexResponse.json();
        const pairs = Array.isArray(dexPayload?.pairs) ? dexPayload.pairs : [];
        const byPool = new Map(pairs.map((pair) => [String(pair?.pairAddress || '').toLowerCase(), pair]));
        markets = markets.map((market) => {
          const pair = byPool.get(String(market.pairAddress || '').toLowerCase());
          if (!pair) return market;
          const websites = Array.isArray(pair.info?.websites) ? pair.info.websites : [];
          const socials = Array.isArray(pair.info?.socials) ? pair.info.socials : [];
          const website = websites.find((entry) => entry && typeof entry.url === 'string')?.url || market.website;
          const x = socials.find((entry) => ['twitter', 'x'].includes(String(entry?.type || '').toLowerCase()))?.url || market.x;
          return {
            ...market,
            baseToken: pair.baseToken || market.baseToken,
            quoteToken: pair.quoteToken || market.quoteToken,
            dexLabel: pair.dexId === 'uniswap' ? `Uniswap ${Array.isArray(pair.labels) && pair.labels[0] ? pair.labels[0] : ''}`.trim() : cleanString(pair.dexId, 40) || market.dexLabel,
            priceUsd: finiteNumberOrNull(pair.priceUsd) ?? market.priceUsd,
            priceChange24h: finiteNumberOrNull(pair.priceChange?.h24) ?? market.priceChange24h,
            volume24h: finiteNumberOrNull(pair.volume?.h24) ?? market.volume24h,
            liquidityUsd: finiteNumberOrNull(pair.liquidity?.usd) ?? market.liquidityUsd,
            marketCap: finiteNumberOrNull(pair.marketCap ?? pair.fdv) ?? market.marketCap,
            chartUrl: cleanString(pair.url, 500) || market.chartUrl,
            website: cleanString(website, 500) || null,
            x: cleanString(x, 500) || null,
          };
        });
      }
    } catch (_) {
      // Pool-index data remains useful when DexScreener is unavailable.
    }
    persistMarketCache(item, markets, Date.parse(payload.observedAt) || Date.now());
    return markets;
  }

  async function readHookTape(item) {
    if(item.chainId!==8453 || !item.address) return {pools:[],activity:null};
    const [poolResponse,activityResponse]=await Promise.all([
      fetch(`/api/tape/pools?hook=${encodeURIComponent(item.address)}&limit=4`,{headers:{Accept:'application/json'}}),
      fetch(`/api/tape/activity?hook=${encodeURIComponent(item.address)}&blocks=1800`,{headers:{Accept:'application/json'}}),
    ]);
    const [poolPayload,activityPayload]=await Promise.all([poolResponse.json().catch(()=>null),activityResponse.json().catch(()=>null)]);
    const pools=poolResponse.ok && Array.isArray(poolPayload?.pools)?poolPayload.pools:[];
    const activity=activityResponse.ok && activityPayload?.summary?activityPayload:null;
    if(!pools.length && !activity) throw new Error('First-party activity failed.');
    return {pools,activity};
  }

  async function inspectSelectedProfile(options) {
    const item = selectedBoardItem();
    if (!item || item.kind !== 'hook' || !item.address) return;
    const settings = options || {};
    if (state.boardLoading.has(item.id)) return;
    state.boardLoading.add(item.id);
    const button = $('hook-profile-inspect');
    button.disabled = true;
    button.textContent = 'Inspecting…';
    if (item.liveInspection) $('hook-profile-live-status').textContent = 'reading';
    const previous = state.boardEvidence.get(item.id) || {};
    const includeContract = settings.includeContract !== false && item.liveInspection && (!settings.automatic || !previous.result);
    const includeMarkets = settings.includeMarkets !== false;
    const includeTape=item.chainId===8453 && settings.includeTape!==false && (!settings.automatic || !previous.tapeLoaded);
    const [contract, markets, tape] = await Promise.allSettled([
      includeContract ? readHook(item.chainId, item.address) : Promise.resolve(null),
      includeMarkets ? readHookMarkets(item, Boolean(settings.forceMarkets)) : Promise.resolve(null),
      includeTape ? readHookTape(item) : Promise.resolve(null),
    ]);
    const next = { ...previous };
    if (contract.status === 'fulfilled' && contract.value) {
      next.result = contract.value;
      delete next.error;
    }
    if (contract.status === 'rejected') next.error = contract.reason?.message || 'RPC read failed.';
    if (markets.status === 'fulfilled' && markets.value) {
      next.markets = markets.value;
      next.marketObservedAt = marketCacheEntry(item, false)?.observedAt || Date.now();
      delete next.marketError;
    }
    if (markets.status === 'rejected') next.marketError = markets.reason?.message || 'Market lookup failed.';
    if(tape.status==='fulfilled' && tape.value){next.tapePools=tape.value.pools;next.tapeActivity=tape.value.activity;next.tapeLoaded=true;delete next.tapeError;}
    if(tape.status==='rejected') next.tapeError=tape.reason?.message || 'First-party activity failed.';
    state.boardEvidence.set(item.id, next);
    if (!settings.automatic && (next.result || next.markets?.length || next.tapePools?.length)) {
      state.inspectionsThisSession += 1;
      updateDeskCounters();
      toast(next.markets?.length ? `${next.markets.length} related markets resolved.` : next.tapePools?.length ? `${next.tapePools.length} finalized pool records resolved.` : 'Contract read complete.', 'info');
    } else if (!settings.automatic && !(next.result || next.markets?.length || next.tapePools?.length)) {
      toast(next.error || next.marketError || next.tapeError || 'Inspection failed.', 'alert');
    }
    state.boardLoading.delete(item.id);
    if (state.boardSelectedId === item.id) {
      renderBoardMarkets(item);
      renderBoardTape(item);
      renderBoardLiveEvidence(item);
      button.disabled = false;
      button.textContent = next.result || next.markets || next.tapePools ? 'Refresh' : 'Inspect';
    }
  }

  function inspectProfileIfNeeded() {
    const item = selectedBoardItem();
    if (!item || item.kind !== 'hook' || !item.address || state.boardLoading.has(item.id)) return;
    const evidence = state.boardEvidence.get(item.id) || {};
    const needsMarkets = !marketCacheEntry(item, true);
    const needsContract = item.liveInspection && !evidence.result;
    const needsTape=item.chainId===8453 && !evidence.tapeLoaded;
    if (needsMarkets || needsContract || needsTape) {
      void inspectSelectedProfile({ automatic: true, includeMarkets: needsMarkets, includeContract: needsContract,includeTape:needsTape });
    }
  }

  function addSelectedToWatchlist() {
    const item = selectedBoardItem();
    if (!item || !item.liveInspection || !item.address) return;
    const list = activeList();
    if (list.items.some((candidate) => candidateKey(candidate) === `${item.chainId}:${item.address}`)) {
      toast('This hook is already in the active watchlist.', 'info');
      return;
    }
    if (list.items.length >= MAX_ITEMS_PER_LIST) {
      toast('The active watchlist is full.', 'alert');
      return;
    }
    const cached = state.boardEvidence.get(item.id)?.result || null;
    list.items.push({
      id: makeId('contract'), chainId: item.chainId, address: item.address,
      label: item.project?.name || null, evidence: cached?.evidence || null,
      observations: cached?.observation ? [cached.observation] : [], lastError: null,
      lastAttemptAt: cached ? Date.now() : null,
    });
    saveModel();
    toast(`${boardItemName(item)} added to ${list.name}.`, 'info');
  }

  function exportBoardView() {
    if (!state.board) return;
    const records = filteredBoardItems().map((item) => ({
      kind: item.kind,
      chainId: item.chainId,
      chain: item.chainName,
      address: item.address,
      project: item.project ? {
        name: item.project.name,
        description: item.project.description,
        type: item.project.type,
        stage: item.project.stage,
        dex: item.project.dex,
        website: item.project.website,
        x: item.project.x,
        provenance: item.project.provenance,
      } : null,
      verifiedContract: item.verifiedContract,
      numberOfPools: item.numberOfPools,
      numberOfSwaps: item.numberOfSwaps,
      tokenRelationship: item.tokenContext || null,
      permissionMask: item.address ? decodePermissions(item.address).value : null,
      enabledPermissions: item.permissions.enabled,
      runtime: item.runtime ? {
        fingerprint: item.runtime.fingerprint,
        codeByteLength: item.runtime.codeByteLength,
        deploymentCount: item.runtime.deploymentCount,
        chainIds: item.runtime.chainIds,
      } : null,
      liveInspection: item.liveInspection,
    }));
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      indexGeneratedAt: state.board.generatedAt ? new Date(state.board.generatedAt).toISOString() : null,
      filters: {
        mode: state.boardMode,
        query: $('board-search').value.trim(), chain: $('board-chain').value,
        capability: $('board-profile').value, sort: $('board-sort').value,
        namedOnly: state.boardProjectsOnly,
      },
      records,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hookline-board-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${formatNumber(records.length)} board records.`, 'info');
  }

  async function loadBoard() {
    try {
      const [response, runtimeResponse] = await Promise.all([
        fetch('/data/hooks.json', { headers: { Accept: 'application/json' } }),
        fetch('/data/runtime-families.json', { headers: { Accept: 'application/json' } }).catch(() => null),
      ]);
      if (!response.ok) throw new Error('Hook index request failed.');
      const snapshot = normalizeBoardSnapshot(await response.json());
      if (!snapshot) throw new Error('Hook index response was incomplete.');
      const runtime = runtimeResponse?.ok ? normalizeRuntimeFamilies(await runtimeResponse.json()) : null;
      attachRuntimeFamilies(snapshot, runtime);
      state.board = snapshot;
      state.boardItems = snapshot.items;
      state.runtimeFamilies = runtime;
      syncBoardSelectionFromHash();
      populateBoardChains();
      renderBoardStats();
      renderBoard();
      renderBoardProfile();
      inspectProfileIfNeeded();
      if(Object.values(state.tape.loaded).some(Boolean)) renderTape();
      void openExecutionRoute();
    } catch (error) {
      $('board-result-count').textContent = 'Hook index unavailable';
      $('board-empty').hidden = false;
      $('board-empty').textContent = error.message;
    }
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

  // Project metadata, pinned observations, and events share one public API.
  // Contribution receipts are private capabilities, kept only in this tab.
  const PROJECT_RECEIPTS_KEY = 'hookline:project-receipts:v1';

  function projectChainName(chainId) {
    return CHAINS[Number(chainId)]?.name || state.board?.chains?.find((chain) => Number(chain.chainId) === Number(chainId))?.name || ({ 10: 'Optimism', 130: 'Unichain', 137: 'Polygon', 143: 'Monad', 146: 'Sonic', 480: 'World Chain', 1868: 'Soneium', 42220: 'Celo', 43114: 'Avalanche', 57073: 'Ink', 81457: 'Blast' })[Number(chainId)] || `Chain ${chainId}`;
  }

  function projectTime(value) {
    if (value == null || value === '') return null;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function projectTimeNode(value, prefix = '') {
    const timestamp = projectTime(value);
    const node = makeElement('time', 'project-timestamp', timestamp == null ? 'Time unavailable' : `${prefix}${relativeTime(timestamp)}`);
    if (timestamp != null) { node.dateTime = new Date(timestamp).toISOString(); node.title = formatDate(timestamp); }
    return node;
  }

  function projectExternalLink(url, label, className = '') {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      const link = makeElement('a', className, label);
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch (_) { return null; }
  }

  function projectInternalLink(path, label, className = '') {
    const link = makeElement('a', className, label);
    link.href = path;
    return link;
  }

  function projectButton(label, action, className = 'btn btn-secondary') {
    const button = makeElement('button', className, label);
    button.type = 'button';
    button.addEventListener('click', action);
    return button;
  }

  async function projectApi(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options, signal: options.signal || AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('The service returned an unreadable response. Please retry.'); }
    if (!response.ok) throw new Error(cleanString(body?.error?.message || body?.message || (typeof body?.error === 'string' ? body.error : ''), 300) || `Request failed (${response.status}). Please retry.`);
    return body;
  }

  function projectNotice(node, message, retry) {
    node.replaceChildren();
    node.hidden = !message;
    if (!message) return;
    node.append(makeElement('span', '', message));
    if (retry) node.append(projectButton('Retry', retry, 'project-text-button'));
  }

  function projectRegistry() { return Array.isArray(state.projects.registry?.projects) ? state.projects.registry.projects : []; }

  function projectDeployments(project) { return Array.isArray(project?.deployments) ? project.deployments : []; }

  function projectCount(project, key) {
    const count = project?.coverage?.[key];
    return Number.isInteger(count) && count >= 0 ? count : key === 'linkedDeployments' ? projectDeployments(project).length : null;
  }

  function projectById(id) { return projectRegistry().find((project) => project.id === id) || null; }

  function validProjectCompareIds(ids) {
    const known = new Set(projectRegistry().map((project) => project.id));
    return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).toLowerCase()).filter((id) => /^[a-z0-9-]{1,60}$/.test(id) && known.has(id)))].slice(0, 4);
  }

  function projectCompareIdsFromHash() {
    const match = location.hash.match(/^#\/projects\/compare\/([a-z0-9,-]+)$/i);
    return match ? validProjectCompareIds(match[1].split(',')) : [];
  }

  function setProjectCompareIds(ids, syncRoute = false) {
    state.projects.compareIds = validProjectCompareIds(ids);
    state.projects.comparison = null;
    state.projects.comparisonError = '';
    state.projects.compareRequest += 1;
    if (syncRoute) {
      const next = state.projects.compareIds.length >= 2 ? `#/projects/compare/${state.projects.compareIds.join(',')}` : '#/projects';
      if (location.hash !== next) location.hash = next;
      else void renderProjectsRoute();
      return;
    }
    renderProjectsBoard();
  }

  function toggleProjectCompare(id) {
    const ids = validProjectCompareIds(state.projects.compareIds);
    if (ids.includes(id)) setProjectCompareIds(ids.filter((value) => value !== id));
    else if (ids.length >= 4) toast('Compare up to four projects at a time.', 'alert');
    else setProjectCompareIds([...ids, id]);
  }

  function renderProjectCompareTray() {
    const tray = $('projects-compare-tray');
    const chips = $('projects-compare-chips');
    const ids = validProjectCompareIds(state.projects.compareIds);
    state.projects.compareIds = ids;
    tray.hidden = ids.length === 0;
    chips.replaceChildren();
    ids.forEach((id) => {
      const project = projectById(id);
      if (!project) return;
      const chip = projectButton(`${project.name} ×`, () => {
        const remaining = state.projects.compareIds.filter((value) => value !== id);
        setProjectCompareIds(remaining, location.hash.startsWith('#/projects/compare/'));
      }, 'project-compare-chip');
      chip.setAttribute('aria-label', `Remove ${project.name} from comparison`);
      chips.append(chip);
    });
    const open = $('projects-compare-open');
    open.disabled = ids.length < 2;
    open.textContent = ids.length >= 2 ? `Compare ${ids.length} projects` : 'Choose one more';
  }

  function fillProjectSelect(node, entries, firstLabel) {
    const value = node.value;
    node.replaceChildren();
    const first = makeElement('option', '', firstLabel);
    first.value = node.id === 'project-contribution-project' ? '' : 'all';
    node.append(first);
    entries.forEach(([id, label]) => { const option = makeElement('option', '', label); option.value = id; node.append(option); });
    if ([...node.options].some((option) => option.value === value)) node.value = value;
  }

  function syncProjectFilters() {
    const projects = projectRegistry();
    const categories = [...new Set(projects.map((project) => project.category).filter(Boolean))].sort();
    const chains = [...new Set(projects.flatMap((project) => projectDeployments(project).map((deployment) => Number(deployment.chainId))))].filter(Number.isFinite).sort((a, b) => projectChainName(a).localeCompare(projectChainName(b)));
    fillProjectSelect($('projects-category'), categories.map((category) => [category, category]), 'All mechanisms');
    fillProjectSelect($('projects-chain'), chains.map((chainId) => [String(chainId), projectChainName(chainId)]), 'All chains');
    const options = [...projects].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((project) => [project.id, project.name]);
    fillProjectSelect($('project-activity-filter'), options, 'All projects');
    fillProjectSelect($('project-contribution-project'), options, 'Select a project');
  }

  async function loadProjects(force = false) {
    if (state.projects.loading) return state.projects.loading;
    if (state.projects.registry && !force) return state.projects.registry;
    state.projects.loading = (async () => {
      try {
        const registry = await projectApi('/api/projects');
        if (!Array.isArray(registry.projects)) throw new Error('Project records were incomplete. Please retry.');
        state.projects.registry = registry;
        state.projects.error = '';
        syncProjectFilters();
        renderProjectsBoard();
        if (selectedBoardItem()) renderHookProjectLinks(selectedBoardItem());
        return registry;
      } catch (error) {
        state.projects.error = error.message || 'Projects could not be loaded.';
        projectNotice($('projects-error'), state.projects.error, () => void loadProjects(true));
        if (!state.projects.registry) $('projects-count').textContent = 'Directory unavailable';
        return null;
      } finally { state.projects.loading = null; }
    })();
    return state.projects.loading;
  }

  function renderProjectsBoard() {
    const query = $('projects-search').value.trim().toLowerCase();
    const category = $('projects-category').value;
    const chainId = $('projects-chain').value;
    const evidence = $('projects-evidence').value;
    const projects = projectRegistry().filter((project) => {
      const deployments = projectDeployments(project);
      if (category !== 'all' && project.category !== category) return false;
      if (chainId !== 'all' && !deployments.some((deployment) => String(deployment.chainId) === chainId)) return false;
      if (evidence && evidence !== 'all' && project.evidenceCoverage?.level !== evidence) return false;
      return !query || [project.name, project.summary, project.category, ...deployments.flatMap((deployment) => [deployment.address, deployment.name, deployment.role, projectChainName(deployment.chainId)])].join(' ').toLowerCase().includes(query);
    });
    const sort = $('projects-sort').value;
    projects.sort((left, right) => {
      const difference = sort === 'deployments' ? projectCount(right, 'linkedDeployments') - projectCount(left, 'linkedDeployments') : sort === 'monitored' ? (projectCount(right, 'observedDeployments') ?? -1) - (projectCount(left, 'observedDeployments') ?? -1) : 0;
      return difference || String(left.name).localeCompare(String(right.name));
    });
    const list = $('projects-list');
    list.replaceChildren();
    projects.forEach((project) => {
      const card = makeElement('article', 'project-card');
      const identity = makeElement('div', 'project-card-identity');
      identity.append(makeElement('span', 'project-category', project.category || 'Mechanism unclassified'), projectInternalLink(`#/projects/${encodeURIComponent(project.id)}`, project.name, 'project-name'), makeElement('p', 'project-card-summary', project.summary || 'Project description not yet available.'));
      const tags = makeElement('div', 'project-chain-tags');
      const chains = [...new Set(projectDeployments(project).map((deployment) => deployment.chainId))];
      chains.forEach((id) => tags.append(makeElement('span', '', projectChainName(id))));
      if (!chains.length) tags.append(makeElement('span', '', 'Deployment links pending'));
      if (project.evidenceCoverage?.label) tags.append(makeElement('span', `project-evidence-tier ${project.evidenceCoverage.level || ''}`, project.evidenceCoverage.label));
      identity.append(tags);
      const coverage = makeElement('div', 'project-card-coverage');
      [['Linked deployments', projectCount(project, 'linkedDeployments')], ['Observed deployments', projectCount(project, 'observedDeployments')], ['Runtime families', projectCount(project, 'runtimeFamilies')]].forEach(([label, value]) => {
        const metric = makeElement('div', '');
        metric.append(makeElement('strong', value == null ? 'unavailable' : '', value == null ? 'Unavailable' : formatNumber(value)), makeElement('span', '', label));
        coverage.append(metric);
      });
      const action = makeElement('div', 'project-card-action');
      const selected = state.projects.compareIds.includes(project.id);
      const compare = projectButton(selected ? 'Selected' : 'Compare', () => toggleProjectCompare(project.id), 'project-compare-toggle');
      compare.setAttribute('aria-pressed', selected ? 'true' : 'false');
      compare.disabled = !selected && state.projects.compareIds.length >= 4;
      action.append(projectInternalLink(`#/projects/${encodeURIComponent(project.id)}`, 'Open project', 'project-open'), compare, makeElement('small', '', project.metadataProvenance || project.provenance || 'Source-linked metadata'));
      if (project.latestObservedAt) action.append(projectTimeNode(project.latestObservedAt, 'Observed '));
      card.append(identity, coverage, action);
      list.append(card);
    });
    $('projects-count').textContent = `${projects.length} of ${projectRegistry().length} projects`;
    const generated = $('projects-generated');
    generated.replaceChildren(projectTimeNode(state.projects.registry?.generatedAt, 'Registry updated '));
    $('projects-empty').hidden = projects.length !== 0;
    projectNotice($('projects-error'), state.projects.error, state.projects.error ? () => void loadProjects(true) : null);
    renderProjectCompareTray();
  }

  function renderHookProjectLinks(item) {
    const node = $('hook-profile-project-directory');
    node.replaceChildren();
    const projects = projectRegistry().filter((project) => projectDeployments(project).some((deployment) => Number(deployment.chainId) === Number(item.chainId) && String(deployment.address).toLowerCase() === String(item.address).toLowerCase()));
    node.hidden = projects.length === 0;
    projects.forEach((project) => {
      node.append(projectInternalLink(`#/projects/${encodeURIComponent(project.id)}`, `Project: ${project.name}`), makeElement('small', '', projectDeployments(project).find((deployment) => Number(deployment.chainId) === Number(item.chainId) && String(deployment.address).toLowerCase() === String(item.address).toLowerCase())?.provenance || project.provenance || 'Source-linked relationship'));
    });
  }

  function projectSection(title, subtitle) {
    const section = makeElement('section', 'project-section');
    const heading = makeElement('div', 'project-section-heading');
    heading.append(makeElement('h2', '', title));
    if (subtitle) heading.append(makeElement('p', '', subtitle));
    section.append(heading);
    return section;
  }

  function projectSourceLinks(project) {
    const links = makeElement('div', 'project-source-links');
    const seen = new Set();
    [{ label: 'Website', url: project.website }, ...(Array.isArray(project.sources) ? project.sources : [])].forEach((source) => {
      if (!source?.url || seen.has(source.url)) return;
      const link = projectExternalLink(source.url, source.label || 'Source');
      if (link) { links.append(link); seen.add(source.url); }
    });
    return links;
  }

  function projectDeploymentLink(deployment) {
    const chainId = Number(deployment.chainId);
    const address = validateAddress(deployment.address);
    if (!address.ok) return null;
    if (state.board?.items.some((item) => Number(item.chainId) === chainId && item.address === address.address)) return projectInternalLink(`#/board/${chainId}/${address.address}`, 'Open hook profile');
    if (SUPPORTED_CHAINS.includes(chainId)) return projectButton('Inspect contract', () => {
      $('inspect-chain').value = String(chainId);
      $('inspect-address').value = address.address;
      location.hash = '#/observatory';
      $('inspect-form').requestSubmit();
    }, 'project-text-button');
    return projectExternalLink(explorerAddressUrl(chainId, address.address), 'Open explorer');
  }

  function renderProjectDeployments(project) {
    const section = projectSection('Deployments', 'Relationship sources are attached to each contract. Index counts are cumulative snapshots, not interval activity.');
    const deployments = projectDeployments(project);
    if (!deployments.length) section.append(makeElement('p', 'projects-empty compact', 'No contract relationships have been linked yet.'));
    deployments.forEach((deployment) => {
      const row = makeElement('article', 'project-deployment');
      const head = makeElement('div', 'project-deployment-head');
      head.append(makeElement('strong', '', deployment.name || deployment.role || 'Contract'), makeElement('span', 'project-category', projectChainName(deployment.chainId)));
      row.append(head, makeElement('code', 'project-address', deployment.address), makeElement('p', 'project-deployment-role', deployment.role || 'Deployment'));
      const counts = [];
      if (deployment.pools != null && Number.isFinite(Number(deployment.pools))) counts.push(`${Number(deployment.pools).toLocaleString()} pools`);
      if (deployment.swaps != null && Number.isFinite(Number(deployment.swaps))) counts.push(`${Number(deployment.swaps).toLocaleString()} swaps`);
      if (counts.length) { const metrics = makeElement('p', 'project-index-counts', `${counts.join(' · ')} · index snapshot`); if (deployment.indexedAt) metrics.append(' · ', projectTimeNode(deployment.indexedAt)); row.append(metrics); }
      const links = makeElement('div', 'project-source-links');
      const profile = projectDeploymentLink(deployment);
      if (profile) links.append(profile);
      const source = projectExternalLink(deployment.sourceUrl, 'Relationship source');
      if (source) links.append(source);
      row.append(links, makeElement('small', 'project-provenance', deployment.provenance || 'Relationship provenance unavailable'));
      section.append(row);
    });
    return section;
  }

  function projectValue(value, meta = {}) {
    if (value == null) return 'Unavailable';
    if (meta.zeroLabel && (value === 0 || value === '0' || value === ZERO_ADDRESS || value === '0x0')) return String(meta.zeroLabel);
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (meta.unit === 'bps' && /^\d{1,9}$/.test(String(value))) return `${Number(value) / 100}% (${value} bps)${meta.basis ? ` · ${meta.basis}` : ''}`;
    if (meta.unit === 'ppm' && /^\d{1,9}$/.test(String(value))) return `${Number(value) / 10000}% (${value} ppm)${meta.basis ? ` · ${meta.basis}` : ''}`;
    if (meta.unit === 'wei' && meta.asset === 'ETH' && /^\d{1,80}$/.test(String(value))) {
      const units = BigInt(value), whole = units / (10n ** 18n), raw = (units % (10n ** 18n)).toString().padStart(18, '0');
      const fraction = raw.replace(/0+$/, '');
      return `${whole.toLocaleString()}${fraction ? `.${fraction.slice(0, 8)}${fraction.length > 8 ? '…' : ''}` : ''} ETH`;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? `${value.toLocaleString()}${meta.unit ? ` ${meta.unit}` : ''}` : 'Unavailable';
    if (typeof value === 'object') return JSON.stringify(value);
    return `${String(value)}${meta.unit ? ` ${meta.unit}` : ''}`;
  }

  function projectSourceLabel(source) {
    return typeof source === 'string' ? source : source?.label || source?.name || source?.method || source?.type || 'Pinned chain observation';
  }

  function projectBlockLink(chainId, kind, value, label) {
    const base = explorerAddressUrl(chainId, ZERO_ADDRESS);
    if (!base || value == null) return null;
    return projectExternalLink(base.replace(/\/address\/[^/]*$/, `/${kind}/${encodeURIComponent(value)}`), label);
  }

  function renderProjectObservations(observations) {
    const section = projectSection('Observed state', 'Direct contract reads, pinned to a block. Configured allocations are not executed payouts.');
    const latest = new Map();
    observations.forEach((observation) => {
      const key = `${observation.chainId}:${observation.address}`;
      if (!latest.has(key) || (projectTime(observation.observedAt) ?? 0) > (projectTime(latest.get(key).observedAt) ?? 0)) latest.set(key, observation);
    });
    if (!latest.size) section.append(makeElement('p', 'projects-empty compact', 'No pinned observations available yet.'));
    latest.forEach((observation) => {
      const card = makeElement('article', 'project-observation');
      const head = makeElement('div', 'project-observation-head');
      head.append(makeElement('strong', '', projectChainName(observation.chainId)), projectTimeNode(observation.observedAt, 'Observed '));
      card.append(head, makeElement('code', 'project-address', observation.address));
      const timestamp = projectTime(observation.observedAt);
      if (timestamp != null && Date.now() - timestamp > 60 * 60 * 1000) card.append(makeElement('p', 'project-stale', 'Stored observation · over one hour old'));
      const fields = makeElement('dl', 'project-observation-fields');
      const values = observation.fields && typeof observation.fields === 'object' ? observation.fields : {};
      const keys = [...new Set([...Object.keys(values), ...Object.keys(observation.probes || {})])];
      keys.forEach((key) => {
        const meta = observation.fieldMeta?.[key] || {};
        const row = makeElement('div', '');
        const label = makeElement('dt', '', meta.label || key.replace(/([a-z])([A-Z])/g, '$1 $2'));
        if (meta.classification) label.append(makeElement('small', '', String(meta.classification).replace(/_/g, ' ')));
        const unavailable = observation.probes?.[key]?.status === 'unavailable';
        const value = makeElement('dd', unavailable ? 'unavailable' : '', unavailable ? 'Unavailable' : projectValue(values[key], meta));
        if (key === 'runtimeFingerprint' && values[key]) { value.textContent = shorten(values[key], 12, 10); value.title = values[key]; }
        if (meta.description) label.title = String(meta.description);
        row.append(label, value);
        fields.append(row);
      });
      if (!keys.length) card.append(makeElement('p', '', 'Field data unavailable.'));
      else card.append(fields);
      const provenance = makeElement('div', 'project-evidence-links');
      provenance.append(makeElement('span', '', projectSourceLabel(observation.source)));
      if (observation.blockTimestamp) provenance.append(projectTimeNode(observation.blockTimestamp, 'Block time '));
      if (observation.finality) provenance.append(makeElement('span', '', observation.finality));
      const blockLink = projectBlockLink(observation.chainId, 'block', observation.blockNumber, `Block ${observation.blockNumber}`);
      if (blockLink) provenance.append(blockLink);
      if (observation.blockHash) { const blockHash = makeElement('code', '', shorten(observation.blockHash, 12, 10)); blockHash.title = observation.blockHash; provenance.append(blockHash); }
      card.append(provenance);
      section.append(card);
    });
    return section;
  }

  function renderProjectEvent(event, showProject = true) {
    const card = makeElement('article', 'project-event');
    const header = makeElement('div', 'project-event-meta');
    if (showProject && event.projectId) header.append(projectInternalLink(`#/projects/${encodeURIComponent(event.projectId)}`, event.projectName || event.projectId));
    if (event.chainId != null) header.append(makeElement('span', '', projectChainName(event.chainId)));
    const signalLabel = ({ factory_launch: 'factory launch', implementation_change: 'implementation change', fee_configuration_change: 'fee configuration', runtime_change: 'runtime change', configuration_change: 'configuration change', outcome: 'observed outcome' })[event.signalType];
    if (signalLabel) header.append(makeElement('span', 'project-event-kind', signalLabel));
    else if (event.classification) header.append(makeElement('span', 'project-event-kind', String(event.classification).replace(/_/g, ' ')));
    if (event.evidence?.backfill === true) header.append(makeElement('span', 'project-event-kind muted', 'historical backfill'));
    header.append(projectTimeNode(event.occurredAt || event.observedAt, event.occurredAt ? '' : 'Observed '));
    card.append(header, makeElement('h3', '', event.title || 'Contract observation'));
    const evidence = event.evidence && typeof event.evidence === 'object' ? event.evidence : {};
    const scope = event.scope || evidence.scope;
    if (scope) card.append(makeElement('p', 'project-event-scope', scope));
    if (event.after && typeof event.after === 'object' && evidence.scope === 'contract event') {
      const facts = makeElement('dl', 'project-observation-fields');
      const candidates = [event.deploymentField,event.hookField,event.poolField,event.amountField,event.recipientField,event.assetField,...Object.keys(event.fieldUnits || {}),
        ...Object.keys(event.fieldLabels || {}),
        'tokenName','tokenSymbol','tokenAddress','token','hook','poolHook','mind','implementation','newOwner','recipient','to','eth','tag','version'];
      const keys = [...new Set(candidates.filter((key) => key && event.after[key] != null))].slice(0, 6);
      keys.forEach((key) => {
        const row = makeElement('div', '');
        const meta = event.fieldUnits?.[key] || (key === event.amountField ? {unit:event.unit,asset:event.asset} : {});
        const raw = event.after[key];
        const label = event.fieldLabels?.[key] || (key === event.recipientField ? 'Recipient' : key === event.amountField ? 'Amount' : key.replace(/([a-z])([A-Z])/g, '$1 $2'));
        const mapped = event.fieldValueLabels?.[key]?.[String(raw)];
        const display = /^0x[0-9a-f]{40}$/i.test(String(raw)) ? projectExternalLink(explorerAddressUrl(event.chainId, raw), shorten(raw, 10, 8)) : makeElement('span', '', mapped ? `${mapped} (${raw})` : projectValue(raw, meta));
        const value = makeElement('dd', ''); value.append(display || String(raw));
        row.append(makeElement('dt', '', label), value); facts.append(row);
      });
      if (keys.length) card.append(facts);
      if(evidence.receiptProof?.status==='transfer_confirmed') {
        card.append(makeElement('p','project-receipt-proof','Burn transfer matched in the successful transaction receipt.'));
      } else if(evidence.receiptProof?.status==='contract_reported') {
        card.append(makeElement('p','project-event-scope','Contract-reported event. Matching token transfer not confirmed.'));
      }
    } else if (event.before != null || event.after != null) {
      const delta = makeElement('div', 'project-event-delta');
      [['Before', event.before], ['After', event.after]].forEach(([label, value]) => {
        const cell = makeElement('div', '');
        cell.append(makeElement('span', '', label), makeElement('code', '', projectValue(value)));
        delta.append(cell);
      });
      card.append(delta);
    }
    const links = makeElement('div', 'project-evidence-links');
    const txHash = event.transactionHash || evidence.transactionHash;
    const blockNumber = event.blockNumber ?? evidence.blockNumber;
    const fromBlock = event.fromBlock ?? evidence.fromBlock ?? evidence.before?.blockNumber;
    const toBlock = event.toBlock ?? evidence.toBlock ?? evidence.after?.blockNumber;
    if (typeof txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(txHash)) {
      const link = projectBlockLink(event.chainId, 'tx', txHash, `Transaction ${shorten(txHash, 8, 6)}`);
      if (link) links.append(link);
    } else if (fromBlock != null || toBlock != null) {
      links.append(makeElement('span', '', `Observation window: blocks ${fromBlock ?? 'unavailable'} to ${toBlock ?? 'unavailable'}`));
    } else if (blockNumber != null) {
      const link = projectBlockLink(event.chainId, 'block', blockNumber, `Block ${blockNumber}`);
      if (link) links.append(link);
    }
    if (event.address) { const addressLink = projectExternalLink(explorerAddressUrl(event.chainId, event.address), shorten(event.address, 8, 6)); if (addressLink) links.append(addressLink); }
    if (evidence.source || event.source) {
      const source = projectSourceLabel(evidence.source || event.source);
      links.append(projectExternalLink(source, 'Reader source') || makeElement('span', '', source));
    }
    card.append(links);
    const receipt = makeElement('details', 'project-event-receipt');
    receipt.append(makeElement('summary', '', 'Evidence record'), makeElement('pre', '', JSON.stringify({ id: event.id, kind: event.kind, chainId: event.chainId, address: event.address, observedAt: event.observedAt, before: event.before, after: event.after, evidence: event.evidence, transactionHash: event.transactionHash, blockNumber: event.blockNumber }, null, 2)));
    card.append(receipt);
    return card;
  }

  function renderProjectRuntimeFamilies(families) {
    const section = projectSection('Runtime identity', 'Exact deployed bytecode. A match is not proof of affiliation, ownership, or identical configuration.');
    if (!Array.isArray(families) || !families.length) {
      section.append(makeElement('p', 'projects-empty compact', 'No project hook is linked to the current runtime-family snapshot.'));
      return section;
    }
    families.forEach((family) => {
      const card=makeElement('article','project-runtime-card');
      const head=makeElement('div','project-deployment-head');
      head.append(makeElement('strong','',`${formatNumber(Number(family.deploymentCount))} exact deployment${Number(family.deploymentCount)===1?'':'s'}`),makeElement('span','project-category',`${(family.chainIds || []).length} chain${(family.chainIds || []).length===1?'':'s'}`));
      const fingerprint=makeElement('code','project-address',family.runtimeFingerprint || 'Fingerprint unavailable');
      fingerprint.title=family.runtimeFingerprint || '';
      card.append(head,fingerprint);
      if(family.runtimeFingerprint) card.append(projectExternalLink(`https://t.me/HooklineTradeBot?start=fam_${family.runtimeFingerprint.slice(0,48)}`,'Follow runtime family','btn btn-secondary btn-compact'));
      if(family.codeByteLength!=null) card.append(makeElement('p','project-index-counts',`${formatNumber(Number(family.codeByteLength))} runtime bytes`));
      if(Array.isArray(family.relatedProjects)&&family.relatedProjects.length) {
        const related=makeElement('div','project-runtime-related');
        related.append(makeElement('span','','Also linked to'));
        family.relatedProjects.forEach((item)=>related.append(projectInternalLink(`#/projects/${encodeURIComponent(item.id)}`,item.name)));
        card.append(related);
      }
      const others=makeElement('div','project-runtime-deployments');
      (family.otherDeployments || []).slice(0,6).forEach((deployment)=>{
        const link=projectInternalLink(`#/board/${deployment.chainId}/${deployment.address}`,deployment.name || shorten(deployment.address,8,6));
        link.title=deployment.address;others.append(link,makeElement('small','',projectChainName(deployment.chainId)));
      });
      if(others.children.length) card.append(others);
      const remaining=Math.max(0,Number(family.deploymentCount || 0)-Number(family.projectDeployments?.length || 0)-Math.min(6,Number(family.otherDeployments?.length || 0)));
      if(remaining) card.append(makeElement('p','project-provenance',`+ ${formatNumber(remaining)} more exact deployment${remaining===1?'':'s'} in the family snapshot`));
      if(family.evidence?.generatedAt) card.append(projectTimeNode(family.evidence.generatedAt,'Snapshot updated '));
      section.append(card);
    });
    return section;
  }

  function comparisonFact(list, label, value) {
    const row = makeElement('div', '');
    row.append(makeElement('dt', '', label), makeElement('dd', value == null ? 'unavailable' : '', value == null ? 'Unavailable' : String(value)));
    list.append(row);
  }

  function renderComparisonObservation(observation) {
    const card = makeElement('section', 'project-comparison-observation');
    const head = makeElement('div', 'project-observation-head');
    const block = observation.blockNumber == null ? 'Block unavailable' : `Block ${formatNumber(Number(observation.blockNumber))}`;
    head.append(makeElement('strong', '', projectChainName(observation.chainId)), makeElement('span', 'project-comparison-block', block));
    card.append(head, makeElement('code', 'project-address', observation.address || 'Address unavailable'));
    if (observation.observedAt) card.append(projectTimeNode(observation.observedAt, 'Observed '));
    const fields = makeElement('dl', 'project-observation-fields project-comparison-fields');
    const values = observation.fields && typeof observation.fields === 'object' ? observation.fields : {};
    const keys = [...new Set([...Object.keys(values), ...Object.keys(observation.probes || {})])];
    keys.forEach((key) => {
      const meta = observation.fieldMeta?.[key] || {};
      const unavailable = observation.probes?.[key]?.status === 'unavailable';
      const raw = unavailable ? null : values[key];
      const label = meta.label || key.replace(/([a-z])([A-Z])/g, '$1 $2');
      let display = unavailable ? 'Unavailable' : projectValue(raw, meta);
      if (key === 'runtimeFingerprint' && raw) display = shorten(String(raw), 12, 10);
      const row = makeElement('div', '');
      row.append(makeElement('dt', '', label), makeElement('dd', unavailable ? 'unavailable' : '', display));
      fields.append(row);
    });
    if (keys.length) card.append(fields);
    else card.append(makeElement('p', 'projects-empty compact', 'Measured fields unavailable.'));
    const source = makeElement('div', 'project-evidence-links');
    source.append(makeElement('span', '', projectSourceLabel(observation.source)));
    if (observation.blockTimestamp) source.append(projectTimeNode(observation.blockTimestamp, 'Block time '));
    if (observation.finality) source.append(makeElement('span', '', observation.finality));
    const link = projectBlockLink(observation.chainId, 'block', observation.blockNumber, block);
    if (link) source.append(link);
    card.append(source);
    return card;
  }

  function renderProjectComparison(body) {
    const root = $('projects-comparison');
    const grid = $('projects-comparison-grid');
    const entries = Array.isArray(body?.projects) ? body.projects : [];
    root.hidden = false;
    grid.replaceChildren();
    entries.forEach((entry) => {
      const project = entry?.project;
      if (!project) return;
      const column = makeElement('article', 'project-comparison-column');
      const head = makeElement('header', 'project-comparison-column-head');
      head.append(makeElement('span', 'project-category', project.category || 'Mechanism unclassified'), projectInternalLink(`#/projects/${encodeURIComponent(project.id)}`, project.name, 'project-name'));
      column.append(head);
      const facts = makeElement('dl', 'project-comparison-facts');
      comparisonFact(facts, 'Evidence coverage', project.evidenceCoverage?.label || null);
      comparisonFact(facts, 'Linked deployments', projectCount(project, 'linkedDeployments') == null ? null : formatNumber(projectCount(project, 'linkedDeployments')));
      comparisonFact(facts, 'Monitored deployments', projectCount(project, 'monitoredDeployments') == null ? null : formatNumber(projectCount(project, 'monitoredDeployments')));
      comparisonFact(facts, 'Observed deployments', projectCount(project, 'observedDeployments') == null ? null : formatNumber(projectCount(project, 'observedDeployments')));
      const chains = [...new Set(projectDeployments(project).map((deployment) => projectChainName(deployment.chainId)))];
      comparisonFact(facts, 'Chain footprint', chains.length ? chains.join(', ') : null);
      comparisonFact(facts, 'Runtime families', projectCount(project, 'runtimeFamilies') == null ? null : formatNumber(projectCount(project, 'runtimeFamilies')));
      comparisonFact(facts, 'Repeated runtimes', projectCount(project, 'repeatedRuntimeFamilies') == null ? null : formatNumber(projectCount(project, 'repeatedRuntimeFamilies')));
      comparisonFact(facts, 'Source-bound reads', project.evidenceCoverage?.readTypes == null ? null : formatNumber(Number(project.evidenceCoverage.readTypes)));
      comparisonFact(facts, 'Source-bound events', project.evidenceCoverage?.eventTypes == null ? null : formatNumber(Number(project.evidenceCoverage.eventTypes)));
      column.append(facts);
      const observed = makeElement('div', 'project-comparison-observations');
      observed.append(makeElement('h3', '', 'Latest observed state'));
      const observations = Array.isArray(entry.observations) ? entry.observations : [];
      if (!observations.length) observed.append(makeElement('p', 'projects-empty compact', 'No pinned observations available.'));
      else observations.forEach((observation) => observed.append(renderComparisonObservation(observation)));
      column.append(observed);
      grid.append(column);
    });
    projectNotice($('projects-comparison-status'), entries.length ? '' : 'Comparison records were unavailable.');
  }

  async function loadProjectComparison(ids) {
    const selected = validProjectCompareIds(ids);
    const root = $('projects-comparison');
    const grid = $('projects-comparison-grid');
    state.projects.compareIds = selected;
    renderProjectCompareTray();
    root.hidden = false;
    grid.replaceChildren();
    if (selected.length < 2) {
      projectNotice($('projects-comparison-status'), 'Choose at least two known projects to compare.');
      return;
    }
    const request = ++state.projects.compareRequest;
    projectNotice($('projects-comparison-status'), 'Loading sourced project evidence…');
    try {
      const body = await projectApi(`/api/project-comparison?ids=${encodeURIComponent(selected.join(','))}`);
      if (request !== state.projects.compareRequest || state.projects.compareIds.join(',') !== selected.join(',')) return;
      if (!Array.isArray(body?.projects)) throw new Error('Comparison records were incomplete.');
      state.projects.comparison = body;
      state.projects.comparisonError = '';
      renderProjectComparison(body);
    } catch (error) {
      if (request !== state.projects.compareRequest) return;
      state.projects.comparisonError = error.message || 'Project comparison could not be loaded.';
      projectNotice($('projects-comparison-status'), state.projects.comparisonError, () => void loadProjectComparison(selected));
    }
  }

  function openProjectComparison() {
    const ids = validProjectCompareIds(state.projects.compareIds);
    if (ids.length < 2) return;
    setProjectCompareIds(ids, true);
  }

  function renderProjectDetail(body) {
    const project = body.project;
    const root = $('project-detail');
    root.replaceChildren();
    root.append(projectInternalLink('#/projects', 'All projects', 'project-back-link'));
    const hero = makeElement('header', 'projects-hero project-detail-hero');
    const title = makeElement('div', '');
    const heading = makeElement('h1', '', project.name);
    heading.id = 'project-detail-title';
    title.append(makeElement('p', 'eyebrow', project.category || 'HOOK PROJECT'), heading, makeElement('p', '', project.summary || 'Description unavailable.'), projectSourceLinks(project));
    $('view-projects').setAttribute('aria-labelledby', 'project-detail-title');
    const actions = makeElement('div', 'project-detail-actions');
    actions.append(projectExternalLink(`https://t.me/HooklineTradeBot?start=project_${encodeURIComponent(project.id)}`, 'Follow in Telegram', 'btn btn-primary'));
    actions.append(projectButton('Add to comparison', () => {
      const ids = validProjectCompareIds(state.projects.compareIds);
      if (!ids.includes(project.id) && ids.length >= 4) { toast('Compare up to four projects at a time.', 'alert'); return; }
      state.projects.compareIds = validProjectCompareIds([...ids, project.id]);
      location.hash = '#/projects';
    }, 'btn btn-secondary'), projectButton('Claim profile', () => openProjectContribution('claim', project.id)), projectButton('Suggest correction', () => openProjectContribution('correction', project.id), 'project-text-button'));
    hero.append(title, actions);
    const coverageLabel=project.evidenceCoverage?.label || 'Coverage unclassified';
    const coverageCounts=project.evidenceCoverage?.level==='source_bound' ? ` · ${formatNumber(project.evidenceCoverage.readTypes || 0)} read type${project.evidenceCoverage.readTypes===1?'':'s'} · ${formatNumber(project.evidenceCoverage.eventTypes || 0)} event type${project.evidenceCoverage.eventTypes===1?'':'s'}` : '';
    root.append(hero, makeElement('p', 'project-provenance', `${project.metadataProvenance || project.provenance || 'Source-linked project metadata'} · ${coverageLabel}${coverageCounts} · Listing does not establish ownership or safety.`));
    const layout = makeElement('div', 'project-detail-layout');
    const primary = makeElement('div', 'project-detail-main');
    primary.append(renderProjectObservations(Array.isArray(body.observations) ? body.observations : []));
    const events = projectSection('Changes & activity', 'Baselines establish state. Changes carry a transaction or observation window.');
    if (Array.isArray(body.monitoring?.targets) && body.monitoring.targets.length) {
      const coverage = makeElement('details', 'project-event-receipt');
      const behind = body.monitoring.targets.filter((target) => target.eventStatus !== 'caught_up').length;
      coverage.append(makeElement('summary', '', behind ? `Event coverage · ${behind} target${behind === 1 ? '' : 's'} catching up or unavailable` : 'Event coverage · caught up to selected finalized blocks'));
      body.monitoring.targets.forEach((target) => {
        const line = makeElement('p', 'project-provenance', `${projectChainName(target.chainId)}, ${shorten(target.address, 10, 8)}, ${target.eventStatus === 'caught_up' ? 'through block ' + target.eventCursorBlock : target.eventStatus === 'behind' ? Number(target.eventLagBlocks || 0).toLocaleString() + ' blocks behind selected tip' : 'event read unavailable'}`);
        if (target.eventThroughAt) line.append(' · block time ', projectTimeNode(target.eventThroughAt));
        coverage.append(line);
      });
      events.append(coverage);
    }
    if (!body.events?.length) events.append(makeElement('p', 'projects-empty compact', 'No change records available yet. This does not establish that no changes occurred.'));
    else body.events.slice(0, 30).forEach((event) => events.append(renderProjectEvent(event, false)));
    primary.append(events);
    const side = makeElement('aside', 'project-detail-side');
    side.append(renderProjectDeployments(project),renderProjectRuntimeFamilies(body.runtimeFamilies));
    if (body.related?.length) {
      const related = projectSection('Explore related mechanisms', 'Shared category, not proof of affiliation or identical code.');
      body.related.forEach((item) => {
        const node = makeElement('div', 'project-related');
        node.append(projectInternalLink(`#/projects/${encodeURIComponent(item.id)}`, item.name), makeElement('small', '', item.reason || 'Shared mechanism category'));
        related.append(node);
      });
      side.append(related);
    }
    layout.append(primary, side);
    root.append(layout);
  }

  async function renderProjectsRoute() {
    const comparisonMatch = location.hash.match(/^#\/projects\/compare\/([a-z0-9,-]+)$/i);
    const detailMatch = location.hash.match(/^#\/projects\/([a-z0-9-]+)$/i);
    const id = comparisonMatch ? null : detailMatch?.[1];
    const request = ++state.projects.detailRequest;
    $('projects-directory').hidden = Boolean(id);
    $('project-detail').hidden = !id;
    if (!id) {
      $('view-projects').setAttribute('aria-labelledby', 'projects-title');
      await loadProjects();
      if (request !== state.projects.detailRequest || viewFromHash() !== 'projects') return;
      if (comparisonMatch) {
        state.projects.compareIds = projectCompareIdsFromHash();
        renderProjectsBoard();
        await loadProjectComparison(state.projects.compareIds);
      } else {
        state.projects.compareRequest += 1;
        state.projects.comparison = null;
        state.projects.comparisonError = '';
        $('projects-comparison').hidden = true;
        renderProjectsBoard();
      }
      return;
    }
    const root = $('project-detail');
    root.replaceChildren(projectInternalLink('#/projects', 'All projects', 'project-back-link'), makeElement('p', 'projects-empty', 'Loading project and evidence…'));
    void loadProjects();
    try {
      const body = await projectApi(`/api/projects/${encodeURIComponent(id)}`);
      if (request !== state.projects.detailRequest || viewFromHash() !== 'projects') return;
      if (!body?.project?.id) throw new Error('Project not found.');
      state.projects.detail = body;
      renderProjectDetail(body);
    } catch (error) {
      if (request !== state.projects.detailRequest || viewFromHash() !== 'projects') return;
      root.replaceChildren(projectInternalLink('#/projects', 'All projects', 'project-back-link'));
      const notice = makeElement('div', 'projects-notice');
      projectNotice(notice, error.message || 'Project evidence could not be loaded.', () => void renderProjectsRoute());
      root.append(notice);
    }
  }

  function renderProjectActivity() {
    const events = state.projects.events;
    const list = $('project-activity-list');
    list.replaceChildren();
    if (!events.length) list.append(makeElement('p', 'projects-empty', state.projects.activityLoaded ? 'No change records in this view yet. First observations establish the baseline.' : 'Loading observed activity…'));
    else events.slice(0, 150).forEach((event) => list.append(renderProjectEvent(event)));
    $('project-activity-generated').replaceChildren(projectTimeNode(state.projects.activityGeneratedAt, 'Feed updated '));
  }

  async function loadProjectActivity(reset = false) {
    const request = ++state.projects.activityRequest;
    const button = $('project-activity-refresh');
    button.disabled = true;
    void loadProjects();
    if(reset){state.projects.events=[];state.projects.activityLoaded=false;renderProjectActivity();}
    if (!state.projects.activityLoaded) renderProjectActivity();
    try {
      const params=new URLSearchParams();
      const project=$('project-activity-filter').value,signal=$('project-activity-signal').value,focus=$('project-activity-focus').value,history=$('project-activity-history').value;
      if(project&&project!=='all') params.set('project',project);
      params.set('signal',signal || 'all');
      params.set('focus',focus || 'important');params.set('history',history || 'all');
      const body = await projectApi(`/api/project-activity?${params}`);
      if (request !== state.projects.activityRequest) return;
      if (!Array.isArray(body.events)) throw new Error('Activity records were incomplete.');
      state.projects.events = body.events;
      state.projects.activityLoaded = true;
      state.projects.activityGeneratedAt = body.generatedAt;
      projectNotice($('project-activity-status'), '');
      renderProjectActivity();
    } catch (error) {
      if (request !== state.projects.activityRequest) return;
      projectNotice($('project-activity-status'), `${error.message || 'Activity unavailable.'}${state.projects.activityLoaded ? ' Last loaded records are preserved.' : ''}`, () => void loadProjectActivity());
    } finally { if (request === state.projects.activityRequest) button.disabled = false; }
  }

  function loadProjectReceipts() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(PROJECT_RECEIPTS_KEY) || '[]');
      state.projects.receipts = Array.isArray(saved) ? saved.filter((receipt) => typeof receipt.id === 'string' && typeof receipt.receiptToken === 'string').slice(0, 20) : [];
    } catch (_) { state.projects.receipts = []; }
  }

  function saveProjectReceipts() {
    try { sessionStorage.setItem(PROJECT_RECEIPTS_KEY, JSON.stringify(state.projects.receipts.slice(0, 20).map(({ busy, ...receipt }) => receipt))); return true; }
    catch (_) { return false; }
  }

  function projectContributionMessage(message, error = false) {
    const node = $('project-contribution-status');
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  function updateProjectContributionFields() {
    const kind = $('project-contribution-kind').value;
    const newProject = kind === 'project';
    $('project-contribution-existing').hidden = newProject;
    $('project-contribution-project').required = !newProject;
    $('project-contribution-project').disabled = newProject;
    $('project-contribution-new-fields').hidden = !newProject;
    ['name', 'website', 'description'].forEach((field) => {
      $(`project-contribution-${field}`).required = newProject;
      $(`project-contribution-${field}`).disabled = !newProject;
    });
    $('project-contribution-contracts').disabled = !newProject;
    $('project-contribution-claim-help').hidden = kind !== 'claim';
    $('project-contribution-message').required = kind === 'correction';
    $('project-contribution-message-field').querySelector('label span').textContent = kind === 'correction' ? 'required' : 'optional';
    $('project-contribution-send').textContent = ({ project: 'Submit project', claim: 'Request claim', correction: 'Submit correction' })[kind];
  }

  async function openProjectContribution(kind = 'project', projectId = '') {
    const dialog = $('project-contribution-dialog');
    const form = $('project-contribution-form');
    form.hidden = kind === 'receipts';
    projectContributionMessage('');
    $('project-contribution-title').textContent = kind === 'receipts' ? 'Your private requests.' : 'Improve the directory.';
    if (kind !== 'receipts') {
      $('project-contribution-kind').value = kind;
      updateProjectContributionFields();
    }
    renderProjectReceipts();
    if (!dialog.open) dialog.showModal();
    await loadProjects();
    if (kind !== 'receipts' && projectId) $('project-contribution-project').value = projectId;
    if (!projectRegistry().length && kind !== 'project' && kind !== 'receipts') projectContributionMessage('The project directory is unavailable. Retry loading it before submitting this request.', true);
  }

  function storeProjectReceipt(body, request) {
    const receipt = { ...body, kind: body.kind || request.kind, projectId: body.projectId || request.projectId, title: request.name || projectRegistry().find((project) => project.id === request.projectId)?.name || 'Project request' };
    const prior = state.projects.receipts.findIndex((item) => item.id === receipt.id);
    if (prior >= 0) state.projects.receipts[prior] = receipt;
    else state.projects.receipts.unshift(receipt);
    state.projects.receipts = state.projects.receipts.slice(0, 20);
    return saveProjectReceipts();
  }

  async function submitProjectContribution(event) {
    event.preventDefault();
    if (state.projects.contributionBusy) return;
    const form = $('project-contribution-form');
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    body.agreement = $('project-contribution-agreement').checked;
    if (body.contact && !/^@[A-Za-z0-9_]{5,32}$/.test(body.contact.trim())) { projectContributionMessage('Use a Telegram handle such as @yourhandle, or leave contact blank.', true); $('project-contribution-contact').focus(); return; }
    for (const field of ['website', 'proofUrl']) {
      if (body[field] && !projectExternalLink(body[field], '')) { projectContributionMessage('Website and evidence links must use https://.', true); return; }
    }
    state.projects.contributionBusy = true;
    $('project-contribution-send').disabled = true;
    projectContributionMessage('Submitting privately…');
    try {
      const result = await projectApi('/api/project-submissions', { method: 'POST', body: JSON.stringify(body) });
      if (!result.id || !result.receiptToken) throw new Error('The request response did not include a private receipt. Do not submit again immediately.');
      const persisted = storeProjectReceipt(result, body);
      form.reset();
      updateProjectContributionFields();
      form.hidden = true;
      projectContributionMessage(`${result.message || 'Request received. Track verification and review below.'}${persisted ? '' : ' This browser could not save the receipt. Copy its access key before closing this page.'}`);
      renderProjectReceipts();
    } catch (error) { projectContributionMessage(error.message || 'Could not confirm submission. Please check your connection.', true); }
    finally { state.projects.contributionBusy = false; $('project-contribution-send').disabled = false; }
  }

  async function updateProjectReceipt(receipt, action = '') {
    if (receipt.busy) return;
    receipt.busy = true;
    projectContributionMessage(action === 'verify' ? 'Checking the project’s DNS proof…' : 'Loading private request status…');
    renderProjectReceipts();
    try {
      const body = await projectApi(`/api/project-submissions/${encodeURIComponent(receipt.id)}${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'GET', headers: { Authorization: `Bearer ${receipt.receiptToken}` } });
      const previousVerification = receipt.verification;
      Object.assign(receipt, body);
      // Status responses deliberately omit the TXT value. Preserve only the current challenge.
      if (body.verification && !body.verification.value && previousVerification?.expiresAt === body.verification.expiresAt) receipt.verification = { ...previousVerification, ...body.verification };
      saveProjectReceipts();
      projectContributionMessage(body.message || body.reason?.message || 'Request status updated.');
    } catch (error) { projectContributionMessage(error.message || 'Request status unavailable.', true); }
    finally { receipt.busy = false; renderProjectReceipts(); }
  }

  function renderOwnerMetadataForm(receipt) {
    const details = makeElement('details', 'project-owner-editor');
    details.append(makeElement('summary', '', 'Update your project profile'));
    const form = makeElement('form', '');
    const project = projectRegistry().find((item) => item.id === receipt.projectId);
    [['name', 'Project name', project?.name || ''], ['website', 'Official website', project?.website || ''], ['description', 'Description', project?.summary || '']].forEach(([name, labelText, value]) => {
      const field = makeElement('label', 'project-form-field');
      field.append(makeElement('span', '', labelText));
      const input = makeElement(name === 'description' ? 'textarea' : 'input', '');
      input.name = name;
      input.value = value;
      input.required = true;
      input.maxLength = name === 'description' ? 1200 : name === 'name' ? 100 : 500;
      if (name === 'website') input.type = 'url';
      field.append(input);
      form.append(field);
    });
    const agreement = makeElement('label', 'project-agreement');
    const checkbox = makeElement('input', '');
    checkbox.type = 'checkbox'; checkbox.required = true; checkbox.name = 'agreement';
    agreement.append(checkbox, makeElement('span', '', 'I’m authorized to update this profile. Contract evidence and historical records remain independent.'));
    const submit = makeElement('button', 'btn btn-primary', 'Save profile update');
    submit.type = 'submit';
    form.append(agreement, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const payload = Object.fromEntries(new FormData(form)); payload.agreement = true;
      if (!projectExternalLink(payload.website, '')) { projectContributionMessage('The official website must use https://.', true); return; }
      submit.disabled = true;
      try {
        const body = await projectApi(`/api/project-submissions/${encodeURIComponent(receipt.id)}/metadata`, { method: 'POST', headers: { Authorization: `Bearer ${receipt.receiptToken}` }, body: JSON.stringify(payload) });
        // The update has its own receipt. Keep the original claim capability intact.
        if (body.id && body.receiptToken) storeProjectReceipt(body, { kind: 'correction', projectId: receipt.projectId, name: receipt.title });
        projectContributionMessage(body.message || 'Profile update approved. Measured evidence is unchanged.');
        await loadProjects(true);
        renderProjectReceipts();
        if (location.hash === `#/projects/${receipt.projectId}`) void renderProjectsRoute();
      } catch (error) { projectContributionMessage(error.message || 'Profile update could not be saved.', true); }
      finally { submit.disabled = false; }
    });
    details.append(makeElement('p', 'project-provenance', 'Domain control authorizes metadata only. Website changes must remain on the verified domain.'), form);
    return details;
  }

  function renderProjectReceipts() {
    const root = $('project-request-receipts');
    root.replaceChildren();
    if (!state.projects.receipts.length) {
      if ($('project-contribution-form').hidden) root.append(makeElement('p', 'projects-empty compact', 'No request receipts in this tab yet.'), projectButton('Submit a project', () => openProjectContribution('project')));
      return;
    }
    root.append(makeElement('h3', '', 'Private request receipts'), makeElement('p', 'project-receipt-warning', 'Saved only in this browser tab. Closing it can remove access. Your access key is a private credential: copy it for later API access, never post it publicly. No email notifications are sent.'));
    state.projects.receipts.forEach((receipt) => {
      const card = makeElement('article', 'project-request-receipt');
      const head = makeElement('div', 'project-deployment-head');
      head.append(makeElement('strong', '', receipt.title || receipt.projectId || 'Project request'), makeElement('span', 'project-category', String(receipt.status || 'pending_review').replace(/_/g, ' ')));
      card.append(head, makeElement('code', 'project-address', receipt.id));
      if (receipt.reason?.message || receipt.message) card.append(makeElement('p', '', receipt.reason?.message || receipt.message));
      const controls = makeElement('div', 'project-source-links');
      const statusButton = projectButton(receipt.busy ? 'Checking…' : 'Check status', () => void updateProjectReceipt(receipt), 'project-text-button');
      statusButton.disabled = Boolean(receipt.busy);
      controls.append(statusButton, projectButton('Copy access key', (event) => copyText(receipt.receiptToken, event.currentTarget), 'project-text-button'));
      card.append(controls);
      if (receipt.status === 'verified_owner') {
        card.append(makeElement('p', 'project-verified-note', `Domain control verified${receipt.proof?.domain ? `: ${receipt.proof.domain}` : ''}. This is not a safety endorsement.`), renderOwnerMetadataForm(receipt));
      } else if (receipt.kind === 'claim' && !['rejected', 'revoked', 'expired'].includes(receipt.status)) {
        const proof = receipt.verification || receipt.challenge;
        if (proof) {
          const instructions = makeElement('div', 'project-dns-proof');
          instructions.append(makeElement('strong', '', 'DNS TXT verification'), makeElement('p', '', 'Add this TXT record at the listed website’s DNS provider. Then check verification here.'));
          [['Record name', proof.name], ['Record value', proof.value]].forEach(([label, value]) => {
            if (!value) return;
            const field = makeElement('div', '');
            field.append(makeElement('span', '', label), makeElement('code', '', value), projectButton('Copy', (event) => copyText(value, event.currentTarget), 'project-text-button'));
            instructions.append(field);
          });
          if (proof.expiresAt) instructions.append(makeElement('p', 'project-provenance', `Challenge expires ${formatDate(proof.expiresAt)}.`));
          card.append(instructions);
        }
        const verificationButtons = makeElement('div', 'project-source-links');
        [projectButton('Check DNS verification', () => void updateProjectReceipt(receipt, 'verify'), 'btn btn-secondary'), projectButton('Get a new DNS challenge', () => void updateProjectReceipt(receipt, 'challenge'), 'project-text-button')].forEach((button) => { button.disabled = Boolean(receipt.busy); verificationButtons.append(button); });
        card.append(verificationButtons);
      }
      root.append(card);
    });
  }

  function setupProjectEvents() {
    $('projects-search').addEventListener('input', renderProjectsBoard);
    ['projects-category', 'projects-chain', 'projects-evidence', 'projects-sort'].forEach((id) => $(id).addEventListener('change', renderProjectsBoard));
    $('projects-submit').addEventListener('click', () => openProjectContribution('project'));
    $('projects-requests').addEventListener('click', () => openProjectContribution('receipts'));
    $('projects-compare-clear').addEventListener('click', () => setProjectCompareIds([], location.hash.startsWith('#/projects/compare/')));
    $('projects-compare-open').addEventListener('click', openProjectComparison);
    $('projects-comparison-close').addEventListener('click', () => {
      state.projects.compareRequest += 1;
      state.projects.comparison = null;
      $('projects-comparison').hidden = true;
      if (location.hash.startsWith('#/projects/compare/')) location.hash = '#/projects';
    });
    $('project-activity-refresh').addEventListener('click', () => void loadProjectActivity());
    ['project-activity-filter','project-activity-signal','project-activity-focus','project-activity-history'].forEach((id)=>$(id).addEventListener('change',()=>void loadProjectActivity(true)));
    $('project-contribution-close').addEventListener('click', () => $('project-contribution-dialog').close());
    $('project-contribution-kind').addEventListener('change', updateProjectContributionFields);
    $('project-contribution-form').addEventListener('submit', submitProjectContribution);
    updateProjectContributionFields();
    loadProjectReceipts();
  }

  function tapeLink(href, text, className) {
    const link=makeElement('a',className || '',text);
    link.href=href;return link;
  }

  function tapeAddress(value, prefix = 8, suffix = 6) {
    return typeof value === 'string' && value.length > prefix + suffix + 1
      ? `${value.slice(0,prefix)}…${value.slice(-suffix)}` : value || 'unavailable';
  }

  function tapeFee(pool) {
    if (pool?.poolFee?.mode === 'dynamic') return 'Dynamic';
    const percent=Number(pool?.poolFee?.percent);
    if (!Number.isFinite(percent)) return 'Unavailable';
    return `${percent.toLocaleString(undefined,{maximumFractionDigits:4})}% static`;
  }

  function tapeHookName(address) {
    if (address === ZERO_ADDRESS) return 'No hook';
    const item=state.board?.items?.find((candidate)=>candidate.id===`8453_${address}`);
    if(!item) return 'Unnamed hook';
    if(item.project?.name || item.verifiedContract?.name) return boardItemName(item);
    return item.runtime?.representativeName ? `Runtime · ${item.runtime.representativeName}` : (item.runtime?.deploymentCount>1 ? `Runtime family · ${shorten(item.runtime.fingerprint,8,6)}` : 'Unlabeled hook');
  }

  function tapeDelta(value) {
    try {
      const amount=BigInt(value),negative=amount<0n,absolute=(negative?-amount:amount).toString();
      const compact=absolute.length>14?`${absolute.slice(0,7)}…${absolute.slice(-5)}`:BigInt(absolute).toLocaleString();
      return `${negative?'−':'+'}${compact}`;
    } catch (_) { return 'Unavailable'; }
  }

  function tapeSwapFee(swap) {
    const percent=Number(swap?.poolManagerFee?.percent);
    return Number.isFinite(percent)?`${percent.toLocaleString(undefined,{maximumFractionDigits:4})}%`:'Unavailable';
  }

  function tapeHeadings(values) {
    const row=$('tape-head-row');row.replaceChildren(...values.map((value)=>makeElement('th','',value)));
  }

  function renderTapeCoverage() {
    const status=state.tape.status;
    if(!status) return;
    const coverage=status.coverage || {},counts=status.counts || {};
    const swaps=state.tape.mode==='swaps';
    if(swaps) {
      const swapCoverage=status.swapCoverage || {},scan=status.swapScan || {};
      $('tape-coverage-title').textContent='Finalized swaps, one source transaction at a time.';
      $('tape-stat-one-label').textContent='SWAPS RECORDED';$('tape-stat-one-note').textContent='finalized hooked-pool swaps';
      $('tape-stat-two-label').textContent='ACTIVE POOLS';$('tape-stat-two-note').textContent='pools with saved swaps';
      $('tape-stat-three-label').textContent='HOOKS ACTIVE';$('tape-stat-three-note').textContent='unique hook addresses';
      $('tape-stat-four-label').textContent='SWAPS THROUGH';$('tape-stat-four-note').textContent='finalized Base block';
      $('tape-pool-count').textContent=formatNumber(Number(counts.swaps));$('tape-hook-count').textContent=formatNumber(Number(counts.swapPools));
      $('tape-live-through').textContent=formatNumber(Number(counts.swapHooks));
      $('tape-history-through').textContent=swapCoverage.liveThrough==null?'—':formatNumber(Number(swapCoverage.liveThrough));
      const from=Number(swapCoverage.liveFrom),through=Number(swapCoverage.liveThrough),finalized=Number(swapCoverage.finalizedBlock);
      const progress=Number.isSafeInteger(from)&&Number.isSafeInteger(through)&&Number.isSafeInteger(finalized)
        ? Math.max(0,Math.min(100,((through-from+1)/Math.max(1,finalized-from+1))*100)):0;
      $('tape-coverage-fill').style.width=`${progress}%`;
      $('tape-coverage-copy').textContent=Number.isSafeInteger(from)&&Number.isSafeInteger(through)
        ? `Finalized swap coverage begins at block ${formatNumber(from)} and is live through ${formatNumber(through)}. Rows are retained only when the pool-to-hook relationship is already resolved.`
        : 'Finalized swap coverage is initializing.';
      $('tape-scan-status').textContent=`${scan.status==='healthy'?'Swap scanner healthy':scan.status==='degraded'?'Swap scanner preserving its last good cursor':'Swap scanner initializing'}${swapCoverage.lagBlocks?` · ${formatNumber(Number(swapCoverage.lagBlocks))} blocks behind`:''}${scan.lastSuccessAt?` · last write ${relativeTime(Date.parse(scan.lastSuccessAt))}`:''} · ${status.swapDerivationVersion || 'swap-event-v1'}`;
    } else {
      $('tape-coverage-title').textContent='Recent blocks stay current while history fills in.';
      $('tape-stat-one-label').textContent='POOLS RECORDED';$('tape-stat-one-note').textContent='finalized initialization logs';
      $('tape-stat-two-label').textContent='HOOKS SEEN';$('tape-stat-two-note').textContent='unique hook addresses';
      $('tape-stat-three-label').textContent='LIVE THROUGH';$('tape-stat-three-note').textContent='finalized Base block';
      $('tape-stat-four-label').textContent='HISTORY THROUGH';$('tape-stat-four-note').textContent='bounded catch-up cursor';
      $('tape-pool-count').textContent=formatNumber(Number(counts.pools));$('tape-hook-count').textContent=formatNumber(Number(counts.hooks));
      $('tape-live-through').textContent=coverage.liveThrough==null?'—':formatNumber(Number(coverage.liveThrough));
      $('tape-history-through').textContent=coverage.historicalThrough==null?'—':formatNumber(Number(coverage.historicalThrough));
      const historicalFrom=Number(coverage.historicalFrom),historicalThrough=Number(coverage.historicalThrough),liveFrom=Number(coverage.liveFrom);
      const total=Math.max(1,liveFrom-historicalFrom),progress=coverage.historicalComplete?100:Math.max(0,Math.min(100,((historicalThrough-historicalFrom+1)/total)*100));
      $('tape-coverage-fill').style.width=`${progress}%`;
      $('tape-coverage-copy').textContent=coverage.historicalComplete
        ? `Historical coverage connects to the live range. Finalized evidence is continuous from block ${formatNumber(historicalFrom)} through ${formatNumber(Number(coverage.liveThrough))}.`
        : `History is indexed through block ${formatNumber(historicalThrough)}. The current finalized range starts at block ${formatNumber(liveFrom)} and is live through ${formatNumber(Number(coverage.liveThrough))}.`;
      const scan=status.scan || {};
      $('tape-scan-status').textContent=`${scan.status==='healthy'?'Pool scanner healthy':scan.status==='degraded'?'Pool scanner preserving its last good cursor':'Pool scanner initializing'}${scan.lastSuccessAt?` · last write ${relativeTime(Date.parse(scan.lastSuccessAt))}`:''} · ${status.derivationVersion || 'initialize-v1'}`;
    }
  }

  function renderTapeLeaders() {
    const section=$('tape-leaders'),list=$('tape-leader-list'),activity=state.tape.activity;
    list.replaceChildren();
    const hooks=state.tape.mode==='swaps' && Array.isArray(activity?.hooks)?activity.hooks.slice(0,6):[];
    section.hidden=!hooks.length;
    if(section.hidden) return;
    $('tape-leader-window').textContent=`blocks ${formatNumber(Number(activity.window.fromBlock))} to ${formatNumber(Number(activity.window.toBlock))}${activity.window.complete?'':' · partial'}`;
    hooks.forEach((entry,index)=>{
      const card=tapeLink(`#/tape/swaps/8453/${entry.hookAddress}`,'','tape-leader-card');
      const identity=makeElement('div','');identity.append(makeElement('span','',String(index+1).padStart(2,'0')),makeElement('strong','',tapeHookName(entry.hookAddress)),makeElement('code','',tapeAddress(entry.hookAddress)));
      const fee=entry.poolManagerFee || {},min=Number(fee.minPercent),max=Number(fee.maxPercent);
      const feeText=Number.isFinite(min)&&Number.isFinite(max)?(min===max?`${min.toLocaleString(undefined,{maximumFractionDigits:4})}%`:`${min.toLocaleString(undefined,{maximumFractionDigits:4})}% to ${max.toLocaleString(undefined,{maximumFractionDigits:4})}%`):'Unavailable';
      const facts=makeElement('div','');facts.append(makeElement('b','',`${formatNumber(Number(entry.swaps))} swaps`),makeElement('span','',`${formatNumber(Number(entry.pools))} pools · ${feeText}`));
      card.append(identity,facts);list.append(card);
    });
  }

  function renderTape() {
    renderTapeCoverage();
    renderTapeLeaders();
    const query=$('tape-search').value.trim().toLowerCase();
    const body=$('tape-body');body.replaceChildren();
    const swaps=state.tape.mode==='swaps',source=swaps?state.tape.swaps:state.tape.pools;
    const rows=source.filter((entry)=>!query || [tapeHookName(entry.hookAddress),entry.hookAddress,entry.poolId,entry.transactionHash,entry.sender,...(entry.currencies || [])].some((value)=>String(value || '').toLowerCase().includes(query)));
    tapeHeadings(swaps?['Block','Hook','Pool','Pool deltas','Swap fee','Evidence']:['Block','Hook','Pool','Currencies','LP fee config','Evidence']);
    $('tape-table').setAttribute('aria-label',swaps?'Finalized Base PoolManager swap evidence':'Finalized Base pool initialization evidence');
    rows.forEach((pool)=>{
      const row=document.createElement('tr');
      const block=document.createElement('td');block.dataset.label='Block';
      const blockLink=tapeLink(`https://basescan.org/block/${pool.blockNumber}`,formatNumber(Number(pool.blockNumber)),'tape-block-link');blockLink.target='_blank';blockLink.rel='noopener noreferrer';block.append(blockLink);
      const hook=document.createElement('td');hook.dataset.label='Hook';
      const hookName=tapeHookName(pool.hookAddress),hookIdentity=makeElement('div','tape-hook-identity');
      if(pool.hookAddress===ZERO_ADDRESS) hookIdentity.append(makeElement('strong','',hookName));
      else {const hookLink=tapeLink(`#/board/${pool.chainId}/${pool.hookAddress}`,hookName,'tape-hook-link');hookLink.title=pool.hookAddress;hookIdentity.append(hookLink,makeElement('code','',tapeAddress(pool.hookAddress)));}
      hook.append(hookIdentity);
      const poolId=document.createElement('td');poolId.dataset.label='Pool';const poolCode=makeElement('code','',tapeAddress(pool.poolId,10,8));poolCode.title=pool.poolId;poolId.append(poolCode);
      const currencies=document.createElement('td');
      if(swaps) {
        currencies.dataset.label='Pool deltas';currencies.className='tape-deltas';
        const first=makeElement('code','',`Δ0 ${tapeDelta(pool.poolDeltas?.amount0)}`),second=makeElement('code','',`Δ1 ${tapeDelta(pool.poolDeltas?.amount1)}`);
        first.title=String(pool.poolDeltas?.amount0 || '');second.title=String(pool.poolDeltas?.amount1 || '');currencies.append(first,second);
      } else {
        currencies.dataset.label='Currencies';
        (pool.currencies || []).forEach((currency,index)=>{if(index) currencies.append(document.createTextNode(', '));if(currency===ZERO_ADDRESS){const native=makeElement('span','','Native ETH');native.title=currency;currencies.append(native);}else{const link=tapeLink(`https://basescan.org/address/${currency}`,tapeAddress(currency,7,5));link.target='_blank';link.rel='noopener noreferrer';link.title=currency;currencies.append(link);}});
      }
      const fee=makeElement('td',swaps?'tape-dynamic':pool.poolFee?.mode === 'dynamic'?'tape-dynamic':'',swaps?tapeSwapFee(pool):tapeFee(pool));fee.dataset.label=swaps?'Swap fee':'LP fee config';
      const evidence=document.createElement('td');evidence.dataset.label='Evidence';evidence.className='tape-evidence';
      const tx=tapeLink(`https://basescan.org/tx/${pool.transactionHash}`,`tx ${tapeAddress(pool.transactionHash,8,6)}`,'tape-tx-link');tx.target='_blank';tx.rel='noopener noreferrer';tx.title=pool.transactionHash;
      const source=makeElement('div','tape-evidence-source');source.append(tx,makeElement('small','',`log ${pool.logIndex}`));evidence.append(source);
      if(swaps && pool.receipt) {
        const flows=Array.isArray(pool.receipt.tokenFlows)?pool.receipt.tokenFlows.length:0;
        const note=makeElement('small','tape-receipt-note',flows?`${formatNumber(flows)} relevant ERC-20 transfer${flows===1?'':'s'} in receipt`:'receipt read · no relevant ERC-20 transfers');
        note.title='Observable receipt logs only. This is not automatic hook-fee attribution.';evidence.append(note);
      }
      if(swaps && pool.trace) {
        const calls=Array.isArray(pool.trace.calls)?pool.trace.calls:[],direct=calls.filter((call)=>call.relationship?.toHook);
        const callbacks=[...new Set(direct.map((call)=>call.callback).filter(Boolean))];
        const override=direct.find((call)=>Number.isFinite(Number(call.callbackReturn?.lpFeeOverridePercent)))?.callbackReturn?.lpFeeOverridePercent;
        const returnedDelta=direct.some((call)=>call.callbackReturn?.deltaNonZero===true);
        const facts=[];
        if(override!=null) facts.push(`returned ${Number(override).toLocaleString(undefined,{maximumFractionDigits:4})}% LP override`);
        else if(returnedDelta) facts.push('returned nonzero swap delta');
        else if(callbacks.length) facts.push(callbacks.join(', '));
        const hookGas=BigInt(String(pool.trace.directHookFrameGasUsed || '0'));
        if(hookGas>0n) facts.push(`${formatNumber(Number(hookGas))} hook-frame gas`);
        if(Number(pool.trace.relevantNativeValueCalls)>0) facts.push(`${formatNumber(Number(pool.trace.relevantNativeValueCalls))} native-value call${Number(pool.trace.relevantNativeValueCalls)===1?'':'s'}`);
        const note=makeElement('small','tape-trace-note',facts.length?facts.join(' · '):'selected hook call path retained');
        note.title='Selected successful transaction trace only. Direct hook call-frame gas includes descendants. This is not a refusal rate or automatic fee attribution.';evidence.append(note);
      }
      row.append(block,hook,poolId,currencies,fee,evidence);body.append(row);
    });
    $('tape-empty').hidden=rows.length>0 || !state.tape.loaded[state.tape.mode];
    $('tape-empty').textContent=swaps?'No loaded swap rows match this search.':'No loaded pool rows match this search.';
    $('tape-result-count').textContent=state.tape.loaded[state.tape.mode]?`${rows.length.toLocaleString()} of ${source.length.toLocaleString()} loaded rows`:'Loading evidence…';
    $('tape-more').hidden=!state.tape.cursors[state.tape.mode] || Boolean(query);
    $('tape-mode-swaps').setAttribute('aria-pressed',String(swaps));$('tape-mode-pools').setAttribute('aria-pressed',String(!swaps));
    $('tape-scope-label').textContent=swaps?'WHAT SWAP ROWS PROVE':'WHAT POOL ROWS PROVE';
    $('tape-scope-copy').textContent=swaps?'Signed pool deltas, the fee PoolManager reported, finalized block, source transaction, normalized ERC-20 receipt logs, and selected hook call paths when available.':'A pool ID, its hook, currencies, configured LP fee at initialization, block, and source transaction.';
    $('tape-limit-label').textContent=swaps?'NOT YET ATTRIBUTED':'SEPARATE MEASUREMENT';
    $('tape-limit-copy').textContent=swaps?'A receipt transfer or call frame is not automatically a hook fee. Current trace coverage contains successful transactions only, so it does not measure refusal rate.':'Current dynamic fees and hook-adjusted outcomes live in swap and trace evidence, not the initialization row.';
  }

  async function loadTape(force = false, append = false) {
    if(state.tape.loading) return;
    const mode=state.tape.mode;
    if(state.tape.loaded[mode] && !force && !append){renderTape();return;}
    state.tape.loading=true;$('tape-refresh').disabled=true;$('tape-more').disabled=true;
    if(!append) projectNotice($('tape-error'),'');
    try {
      const cursor=append&&state.tape.cursors[mode]?`&cursor=${encodeURIComponent(state.tape.cursors[mode])}`:'';
      const evidenceRequest=fetch(`/api/tape/${mode}?limit=100${cursor}`,{headers:{Accept:'application/json'},cache:force?'no-store':'default'});
      const requests=append?[evidenceRequest]:[fetch('/api/tape/status',{headers:{Accept:'application/json'},cache:force?'no-store':'default'}),evidenceRequest];
      if(!append && mode==='swaps') requests.push(fetch('/api/tape/activity?blocks=1800',{headers:{Accept:'application/json'},cache:force?'no-store':'default'}));
      const responses=await Promise.all(requests);
      const payloads=await Promise.all(responses.map((entry)=>entry.json().catch(()=>null)));
      const required=append?responses:responses.slice(0,2);
      if(required.some((entry)=>!entry.ok)) throw new Error('Tape evidence is temporarily unavailable.');
      const evidenceBody=append?payloads[0]:payloads[1],key=mode;
      if(!evidenceBody || !Array.isArray(evidenceBody[key])) throw new Error('Tape response was incomplete.');
      if(!append) {
        if(!payloads[0]?.coverage) throw new Error('Tape coverage was incomplete.');
        state.tape.status=payloads[0];state.tape[key]=evidenceBody[key];
        if(mode==='swaps' && responses[2]?.ok && Array.isArray(payloads[2]?.hooks)) state.tape.activity=payloads[2];
      } else {
        const existing=new Set(state.tape[key].map((entry)=>entry.id));
        state.tape[key].push(...evidenceBody[key].filter((entry)=>!existing.has(entry.id)));
      }
      state.tape.cursors[mode]=evidenceBody.nextCursor || null;state.tape.loaded[mode]=true;state.tape.error='';renderTape();
    } catch(error) {
      state.tape.error=error.message || 'Tape evidence could not be loaded.';
      projectNotice($('tape-error'),`${state.tape.error}${state.tape.loaded[mode]?' Last loaded evidence is preserved.':''}`,()=>void loadTape(true));
      if(state.tape.loaded[mode]) renderTape();
    } finally {state.tape.loading=false;$('tape-refresh').disabled=false;$('tape-more').disabled=false;}
  }

  function setupTapeEvents() {
    $('tape-refresh').addEventListener('click',()=>void loadTape(true));
    $('tape-more').addEventListener('click',()=>void loadTape(false,true));
    $('tape-search').addEventListener('input',renderTape);
    $('tape-mode-swaps').addEventListener('click',()=>{state.tape.mode='swaps';void loadTape();});
    $('tape-mode-pools').addEventListener('click',()=>{state.tape.mode='pools';void loadTape();});
  }

  function viewFromHash() {
    const value = (location.hash.replace(/^#\/?/, '') || 'board').split('/')[0];
    return VIEWS.has(value) ? value : 'board';
  }

  function boardItemIdFromHash() {
    const match = location.hash.match(/^#\/board\/([0-9]+)\/(0x[0-9a-fA-F]{40})$/);
    return match ? `${Number(match[1])}_${match[2].toLowerCase()}` : null;
  }

  function syncBoardSelectionFromHash() {
    if (!state.board) return;
    const id = boardItemIdFromHash();
    if (id && state.board.items.some((item) => item.id === id)) state.boardSelectedId = id;
  }

  function renderView() {
    if (!location.hash.startsWith('#/trade/')) {
      state.execution.handoffHash = null;
      state.execution.handoffRequest += 1;
    }
    const view = viewFromHash();
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === 'view-' + view));
    $$('[data-view]').forEach((link) => {
      const active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (view === 'board') { syncBoardSelectionFromHash(); renderBoard(); renderBoardProfile(); inspectProfileIfNeeded(); }
    else document.body.classList.remove('board-profile-open');
    if (view === 'projects') void renderProjectsRoute();
    else state.projects.detailRequest += 1;
    if (view === 'activity') void loadProjectActivity();
    if (view === 'tape') {
      const typed=location.hash.match(/^#\/tape\/(swaps|pools)\/8453\/(0x[0-9a-fA-F]{40})$/);
      const legacy=location.hash.match(/^#\/tape\/8453\/(0x[0-9a-fA-F]{40})$/);
      if(typed){state.tape.mode=typed[1];$('tape-search').value=typed[2].toLowerCase();}
      else if(legacy){state.tape.mode='swaps';$('tape-search').value=legacy[1].toLowerCase();}
      else if(location.hash==='#/tape') $('tape-search').value='';
      void loadTape();
    }
    if (view === 'watchlists') renderWatchlists();
    if (view === 'network') renderTelemetry(state.metrics);
    if (location.hash.startsWith('#/trade/')) void openExecutionRoute();
    if (location.hash === '#/wallets') void openWalletSetup();
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
    $('top-wallet').addEventListener('click', () => void openWalletSetup());
    $('account-wallet-setup').addEventListener('click', () => void openWalletSetup());
    $('execution-wallet-setup').addEventListener('click', () => void openWalletSetup());
    $('board-search').addEventListener('input', (event) => {
      state.boardVisible = BOARD_PAGE_SIZE;
      if (state.boardMode === 'hook') {
        renderBoard();
        return;
      }
      clearTimeout(state.tokenSearchTimer);
      const query = event.currentTarget.value;
      state.tokenSearchTimer = setTimeout(() => { void loadTokenRelationships(query); }, 320);
    });
    ['board-chain', 'board-profile', 'board-sort'].forEach((id) => {
      $(id).addEventListener('change', () => { state.boardVisible = BOARD_PAGE_SIZE; renderBoard(); });
    });
    $('board-mode-hook').addEventListener('click', () => setBoardMode('hook'));
    $('board-mode-token').addEventListener('click', () => setBoardMode('token'));
    $('board-projects-only').addEventListener('click', (event) => {
      state.boardProjectsOnly = !state.boardProjectsOnly;
      state.boardVisible = BOARD_PAGE_SIZE;
      event.currentTarget.setAttribute('aria-pressed', String(state.boardProjectsOnly));
      renderBoard();
    });
    $('board-more').addEventListener('click', () => { state.boardVisible += BOARD_PAGE_SIZE; renderBoard(); });
    $('board-export').addEventListener('click', exportBoardView);
    $('hook-profile-close').addEventListener('click', () => {
      state.boardSelectedId = null;
      history.replaceState(null, '', '#/board');
      renderBoard();
      renderBoardProfile();
    });
    $('hook-profile-backdrop').addEventListener('click', () => $('hook-profile-close').click());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && viewFromHash() === 'board' && !$('execution-dialog').open && !$('project-contribution-dialog').open && state.boardSelectedId) $('hook-profile-close').click();
    });
    $('hook-profile-copy').addEventListener('click', (event) => {
      const item = selectedBoardItem();
      if (item?.address) copyText(item.address, event.currentTarget);
    });
    $('hook-profile-inspect').addEventListener('click', () => inspectSelectedProfile({ forceMarkets: true }));
    $('hook-profile-watch').addEventListener('click', addSelectedToWatchlist);
    $('hook-profile-share').addEventListener('click', (event) => copyText(location.href, event.currentTarget));
    $('execution-close').addEventListener('click', () => $('execution-dialog').close());
    $('execution-side-buy').addEventListener('click', () => {
      if (state.execution.busy) return;
      state.execution.side = 'buy';
      state.execution.pendingSellPercent = null;
      $('execution-amount').value = '';
      renderExecutionPair();
    });
    $('execution-side-sell').addEventListener('click', () => {
      if (state.execution.busy) return;
      state.execution.side = 'sell';
      state.execution.pendingSellPercent = null;
      $('execution-amount').value = '';
      renderExecutionPair();
    });
    $('execution-amount').addEventListener('input', () => { state.execution.pendingSellPercent = null; resetExecutionQuote(); });
    $('execution-slippage').addEventListener('input', () => { renderExecutionSettingsSummary(); resetExecutionQuote(); });
    $('execution-settings-save').addEventListener('click', saveExecutionPreferences);
    $('execution-disconnect').addEventListener('click', disconnectExecutionWallet);
    $('execution-switch-wallet').addEventListener('click', async () => {
      try { await switchExecutionWallet(); }
      catch (error) { setExecutionMessage(error.message || 'Choose another account in your wallet, then reconnect.', 'error'); }
    });
    $('execution-wallet').addEventListener('click', async () => {
      if (state.execution.busy) return;
      try {
        await connectExecutionWallet();
        setExecutionMessage('Wallet connected. Enter an amount for a live quote.', 'success');
      } catch (error) {
        setExecutionMessage(error.message || 'Wallet connection failed.', 'error');
      }
    });
    $('execution-submit').addEventListener('click', () => { void advanceExecution(); });
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
      state.pendingLocalReads++;
      try { await importWatchlists(event.target.files && event.target.files[0]); }
      catch (error) { toast(error.message, 'alert'); }
      finally { state.pendingLocalReads--;event.target.value = ''; }
    });
    $('refresh-telemetry-btn').addEventListener('click', () => loadTelemetry(true));
    $$('[data-copy]').forEach((button) => button.addEventListener('click', (event) => copyText(button.dataset.copy, event.currentTarget)));
    window.addEventListener('hashchange', renderView);
    setupProjectEvents();
    setupTapeEvents();
  }

  function init() {
    state.model = loadModel();
    saveModel();
    setupEvents();
    renderWatchlists();
    renderView();
    loadBoard();
    void loadProjects();
    setupWebMCP();
    restoreExecutionWallet();
    loadHealth();
    loadTelemetry(false);
    void import('/accounts-ui.js').then(({mountAccounts})=>{
      state.accountController=mountAccounts({
        getWatchlists:()=>state.model,
        setWatchlists:model=>{state.model=normalizeModel(model,true);state.selectedId=null;saveModel();renderWatchlists();},
        getPreferences:loadExecutionPreferences,
        setPreferences:preferences=>{
          const normalized=normalizeExecutionPreferences(preferences);
          localStorage.setItem(EXECUTION_PREFERENCES_KEY,JSON.stringify(normalized));
          state.execution.preferences=normalized;
          $('execution-slippage').value=String(normalized.slippageBps/100);
          $('execution-buy-presets').value=normalized.buyPresets.join(', ');
          $('execution-sell-presets').value=normalized.sellPresets.join(', ');
          resetExecutionQuote();renderExecutionPresets();renderExecutionSettingsSummary();
        },
        isBusy:()=>state.execution.busy || hasPendingExecution() || Boolean(state.wallets.controller?.isBusy())
          || state.refreshing || state.pendingLocalReads>0 || state.boardLoading.size>0,
        connectWallet:connectAccountWallet,
        clearDevice:()=>{
          [WATCHLISTS_KEY,WATCHLISTS_V2_KEY,EXECUTION_PREFERENCES_KEY,MARKET_CACHE_KEY].forEach(key=>localStorage.removeItem(key));
          state.model=blankModel();state.selectedId=null;state.inspected=null;
          state.boardEvidence.clear();state.execution.preferences=loadExecutionPreferences();
          $('evidence-heading').textContent='Awaiting inspection';
          $('evidence-empty').textContent='Run an inspection to populate verified contract evidence.';
          $('evidence-empty').hidden=false;$('inspect-evidence-grid').replaceChildren();
          $('inspect-perm-grid').replaceChildren();$('inspect-permissions').hidden=true;
          $('inspect-freshness').textContent='';$('inspect-form-error').textContent='';
          $('save-inspect-btn').disabled=true;state.inspectionsThisSession=0;
          $('execution-slippage').value=String(state.execution.preferences.slippageBps/100);
          $('execution-buy-presets').value=state.execution.preferences.buyPresets.join(', ');
          $('execution-sell-presets').value=state.execution.preferences.sellPresets.join(', ');
          $('hook-profile-close').click();renderBoard();renderExecutionPresets();renderExecutionSettingsSummary();updateDeskCounters();
          saveModel();renderWatchlists();resetExecutionQuote();
        },
      });
    }).catch(()=>{$('top-account').disabled=true;$('top-account').textContent='Sign-in unavailable';});
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
