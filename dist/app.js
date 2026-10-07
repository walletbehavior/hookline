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
  const VIEWS = new Set(['board', 'observatory', 'watchlists', 'network', 'docs']);
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
      capability: null,
      busy: false,
      tokenCache: new Map(),
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

  function executionProvider() {
    const injected = globalThis.ethereum;
    if (!injected) return null;
    if (Array.isArray(injected.providers)) return injected.providers.find((provider) => provider?.isMetaMask) || injected.providers[0] || null;
    return injected;
  }

  function nativeSymbol(chainId) {
    return EXECUTION_CHAINS[chainId]?.nativeCurrency?.symbol || 'ETH';
  }

  function executionTokenDescriptor(raw, chainId) {
    if (!raw || typeof raw !== 'object') return null;
    const symbol = cleanString(raw.symbol, 24) || 'TOKEN';
    const address = String(raw.address || '').trim().toLowerCase();
    const native = address === ZERO_ADDRESS || address === NATIVE_TOKEN_ADDRESS
      || (!/^0x[0-9a-f]{40}$/.test(address) && symbol.toUpperCase() === nativeSymbol(chainId));
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
    state.execution.quote = null;
    state.execution.receipt = null;
    state.execution.submittedHash = null;
    $('execution-quote').hidden = true;
    $('execution-receipt').hidden = true;
    $('execution-output').textContent = '—';
    $('execution-minimum').textContent = '—';
    $('execution-fee').textContent = '1.00% gross';
    $('execution-cashback').textContent = '0.30% instant · 0.70% net';
    const submit = $('execution-submit');
    submit.disabled = !state.execution.account || !$('execution-amount').value.trim() || state.execution.busy;
    submit.textContent = state.execution.account ? 'Get quote' : 'Connect wallet';
  }

  function renderExecutionPair() {
    const pair = executionPair(state.execution.side);
    $('execution-input-symbol').textContent = pair?.input?.symbol || 'TOKEN';
    $('execution-token').textContent = pair ? `${pair.input.symbol} / ${pair.output.symbol}` : 'PAIR UNAVAILABLE';
    $('execution-side-buy').setAttribute('aria-pressed', String(state.execution.side === 'buy'));
    $('execution-side-sell').setAttribute('aria-pressed', String(state.execution.side === 'sell'));
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

  function openExecutionDialog(item, market) {
    const execution = state.execution;
    execution.item = item;
    execution.market = market;
    execution.side = 'buy';
    execution.quote = null;
    execution.capability = null;
    execution.busy = false;
    $('execution-chain').textContent = item.chainName.toUpperCase();
    $('execution-pool').textContent = market.pairAddress || market.poolId || '';
    $('execution-behavior').textContent = capabilitySentence(item);
    $('execution-amount').value = '';
    setExecutionMessage('', '');
    const presets = $('execution-presets');
    presets.replaceChildren();
    ['0.01', '0.05', '0.1', '1'].forEach((amount) => {
      const button = makeElement('button', '', amount);
      button.type = 'button';
      button.addEventListener('click', () => {
        $('execution-amount').value = amount;
        resetExecutionQuote();
      });
      presets.append(button);
    });
    $('execution-wallet').textContent = execution.account ? shorten(execution.account, 7, 5) : 'Connect wallet';
    renderExecutionPair();
    const dialog = $('execution-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    void Promise.allSettled([executionModule(), loadExecutionCapability(item.chainId)]).then((results) => {
      if (results[1].status === 'rejected') setExecutionMessage(results[1].reason.message, 'error');
    });
  }

  function renderWalletIdentity() {
    const account = state.execution.account;
    const top = $('top-wallet');
    top.textContent = account ? shorten(account, 7, 5) : 'Connect wallet';
    top.classList.toggle('connected', Boolean(account));
    top.title = account ? 'Disconnect wallet from Hookline' : 'Connect an EVM wallet';
    $('execution-wallet').textContent = account ? shorten(account, 7, 5) : 'Connect wallet';
  }

  function disconnectExecutionWallet() {
    state.execution.account = null;
    state.execution.quote = null;
    state.execution.receipt = null;
    renderWalletIdentity();
    resetExecutionQuote();
    toast('Wallet disconnected from Hookline.', 'info');
  }

  async function connectExecutionWallet() {
    const provider = executionProvider();
    if (!provider || typeof provider.request !== 'function') throw new Error('Open Hookline in a browser with an EVM wallet.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const checked = validateAddress(accounts?.[0]);
    if (!checked.ok) throw new Error('The wallet did not return a valid account.');
    state.execution.account = checked.address;
    renderWalletIdentity();
    resetExecutionQuote();
    return { provider, account: checked.address };
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
    if (typeof provider.on === 'function') {
      provider.on('accountsChanged', (accounts) => {
        const checked = validateAddress(accounts?.[0]);
        state.execution.account = checked.ok ? checked.address : null;
        state.execution.quote = null;
        state.execution.receipt = null;
        renderWalletIdentity();
        resetExecutionQuote();
      });
      provider.on('chainChanged', () => resetExecutionQuote());
    }
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
    if (state.execution.busy) return;
    state.execution.busy = true;
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
        slippageBps: Number($('execution-slippage').value),
      });
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
      state.execution.quote = payload.quote;
      renderExecutionQuote(pair, payload.quote);
    } catch (error) {
      state.execution.quote = null;
      $('execution-quote').hidden = true;
      setExecutionMessage(error.message || 'Quote unavailable.', 'error');
    } finally {
      state.execution.busy = false;
      if (!state.execution.quote) resetExecutionQuote();
    }
  }

  async function waitForWalletReceipt(provider, transactionHash) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
      if (receipt) {
        if (String(receipt.status).toLowerCase() !== '0x1') throw new Error('The transaction reverted.');
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('Transaction submitted. Confirmation is still pending.');
  }

  async function approveExecutionToken(pair, quote) {
    const provider = executionProvider();
    const spender = String(quote.allowance?.spender || '').toLowerCase();
    const amount = String(quote.allowance?.required_amount_base_units || '');
    if (!provider || !/^0x[0-9a-f]{40}$/.test(spender) || !/^\d+$/.test(amount) || pair.input.native) {
      throw new Error('Exact token approval is unavailable.');
    }
    const data = `0x095ea7b3${spender.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{
      from: state.execution.account,
      to: pair.input.address,
      data,
      value: '0x0',
    }] });
    setExecutionMessage('Approval submitted. Waiting for confirmation…', '');
    await waitForWalletReceipt(provider, hash);
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
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [walletTransaction] });
    state.execution.submittedHash = hash;
    setExecutionMessage(`Submitted ${shorten(hash, 10, 8)}. Waiting for confirmation…`, '');
    await waitForWalletReceipt(provider, hash);
    setExecutionMessage(`Confirmed onchain. Verifying Hookline receipt…`, '');
    const response = await fetch('/api/execution/receipt', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_id: intent.intent_id, transaction_hash: hash }),
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

  async function advanceExecution() {
    const quote = state.execution.quote;
    if (!quote) return requestExecutionQuote();
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
    state.execution.busy = true;
    $('execution-submit').disabled = true;
    let approved = false;
    try {
      await ensureExecutionChain(provider, state.execution.item.chainId);
      const pair = await resolvedExecutionPair();
      if (quote.allowance?.state === 'approval_required') approved = await approveExecutionToken(pair, quote);
      else await submitExecutionTransaction(quote);
    } catch (error) {
      if (state.execution.submittedHash) {
        setExecutionMessage(`Transaction ${shorten(state.execution.submittedHash, 10, 8)} was submitted. Receipt verification needs another check; do not resubmit.`, 'error');
        $('execution-submit').disabled = true;
        $('execution-submit').textContent = 'Submitted';
      } else {
        setExecutionMessage(error.message || 'Wallet action failed.', 'error');
        $('execution-submit').disabled = false;
      }
    } finally {
      state.execution.busy = false;
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
        makeElement('strong', '', market.baseToken?.symbol ? `$${market.baseToken.symbol}` : market.poolName),
        makeElement('span', '', market.baseToken?.name || market.poolName || 'Token market'),
      );
      const change = finiteNumberOrNull(market.priceChange24h);
      const changeNode = makeElement('b', change != null ? (change > 0 ? 'positive' : change < 0 ? 'negative' : '') : '', change != null ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '—');
      head.append(identity, changeNode);
      const pair = makeElement('p', 'market-pair', `${market.baseToken?.symbol || '?'} / ${market.quoteToken?.symbol || '?'} · ${market.dexLabel || 'DEX'}`);
      const stats = makeElement('div', 'market-stats');
      const advertisedFee = finiteNumberOrNull(market.advertisedFeePercent);
      [
        ['PRICE', formatUsd(market.priceUsd, false)],
        ['MKT CAP', formatUsd(market.marketCap, true)],
        ['LIQ', formatUsd(market.liquidityUsd, true)],
        ['VOL 24H', formatUsd(market.volume24h, true)],
        ['POOL FEE', advertisedFee == null ? '—' : `${advertisedFee}% advertised`],
      ].forEach(([label, value]) => {
        const stat = makeElement('div', '');
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
    const [contract, markets] = await Promise.allSettled([
      includeContract ? readHook(item.chainId, item.address) : Promise.resolve(null),
      includeMarkets ? readHookMarkets(item, Boolean(settings.forceMarkets)) : Promise.resolve(null),
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
    state.boardEvidence.set(item.id, next);
    if (!settings.automatic && (next.result || next.markets?.length)) {
      state.inspectionsThisSession += 1;
      updateDeskCounters();
      toast(next.markets?.length ? `${next.markets.length} related markets resolved.` : 'Contract read complete.', 'info');
    } else if (!settings.automatic && !(next.result || next.markets?.length)) {
      toast(next.error || next.marketError || 'Inspection failed.', 'alert');
    }
    state.boardLoading.delete(item.id);
    if (state.boardSelectedId === item.id) {
      renderBoardMarkets(item);
      renderBoardLiveEvidence(item);
      button.disabled = false;
      button.textContent = next.result || next.markets ? 'Refresh' : 'Inspect';
    }
  }

  function inspectProfileIfNeeded() {
    const item = selectedBoardItem();
    if (!item || item.kind !== 'hook' || !item.address || state.boardLoading.has(item.id)) return;
    const evidence = state.boardEvidence.get(item.id) || {};
    const needsMarkets = !marketCacheEntry(item, true);
    const needsContract = item.liveInspection && !evidence.result;
    if (needsMarkets || needsContract) {
      void inspectSelectedProfile({ automatic: true, includeMarkets: needsMarkets, includeContract: needsContract });
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
    const view = viewFromHash();
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === 'view-' + view));
    $$('[data-view]').forEach((link) => {
      const active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (view === 'board') { syncBoardSelectionFromHash(); renderBoard(); renderBoardProfile(); inspectProfileIfNeeded(); }
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
    $('top-wallet').addEventListener('click', async () => {
      if (state.execution.account) {
        disconnectExecutionWallet();
        return;
      }
      try {
        await connectExecutionWallet();
        toast('Wallet connected for reviewed execution.', 'info');
      } catch (error) {
        toast(error.message || 'Wallet connection failed.', 'alert');
      }
    });
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
      if (event.key === 'Escape' && !$('execution-dialog').open && state.boardSelectedId) $('hook-profile-close').click();
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
      state.execution.side = 'buy';
      renderExecutionPair();
    });
    $('execution-side-sell').addEventListener('click', () => {
      state.execution.side = 'sell';
      renderExecutionPair();
    });
    $('execution-amount').addEventListener('input', resetExecutionQuote);
    $('execution-slippage').addEventListener('change', resetExecutionQuote);
    $('execution-wallet').addEventListener('click', async () => {
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
      try { await importWatchlists(event.target.files && event.target.files[0]); }
      catch (error) { toast(error.message, 'alert'); }
      finally { event.target.value = ''; }
    });
    $('refresh-telemetry-btn').addEventListener('click', () => loadTelemetry(true));
    $$('[data-copy]').forEach((button) => button.addEventListener('click', (event) => copyText(button.dataset.copy, event.currentTarget)));
    window.addEventListener('hashchange', renderView);
  }

  function init() {
    state.model = loadModel();
    saveModel();
    setupEvents();
    renderWatchlists();
    renderView();
    loadBoard();
    setupWebMCP();
    restoreExecutionWallet();
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
