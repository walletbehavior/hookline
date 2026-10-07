import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildQuoteRequest, parseDisplayToBaseUnits } from '../dist/execution-rail.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.handlers = new Map(); this.attributes = new Map(); this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map((node) => typeof node === 'string' ? node : node.textContent).join(''); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(key, handler) { this.handlers.set(key, handler); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag)]));
const storage = new Map();
const document = { readyState: 'loading', body: new Element(), createElement: (tag) => new Element(tag), getElementById: (id) => nodes.get(id), addEventListener() {}, querySelectorAll: (selector) => selector === '#execution-presets button' ? nodes.get('execution-presets').children : [] };
let fetcher = async (url) => { throw new Error(`Unexpected request: ${url}`); };
const walletCalls = [];
const A = `0x${'1'.repeat(40)}`, TOKEN = `0x${'2'.repeat(40)}`, HOOK = `0x${'3'.repeat(40)}`, OTHER = `0x${'4'.repeat(40)}`;
const POOL = `0x${'5'.repeat(64)}`, ZERO = `0x${'0'.repeat(40)}`;
let walletBalance = 3n;
let walletChain = '0x2105';
const context = vm.createContext({ document, window: {}, URL, URLSearchParams, Date, console, location: { hash: '#/board', origin: 'https://hookline.world' },
  setTimeout: () => 0, clearTimeout() {},
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  fetch: (...args) => fetcher(...args),
  ethereum: { request: async ({ method, params }) => { walletCalls.push({ method, params }); if (method === 'eth_chainId') return walletChain; if (method === 'eth_call') return `0x${walletBalance.toString(16).padStart(64, '0')}`; if (method === 'eth_requestAccounts') return [A]; if (method === 'wallet_requestPermissions') return []; throw new Error(`Unexpected wallet mutation: ${method}`); } },
});
const exported = ['state', 'parseExecutionRoute', 'relationshipMatchesTrade', 'marketForTrade', 'normalizeExecutionPreferences', 'loadExecutionPreferences', 'saveExecutionPreferences', 'executionSlippageBps', 'exactBalancePercent', 'applyExecutionSellPercent', 'executionQuoteContext', 'requestExecutionQuote', 'openExecutionRoute', 'openExecutionDialog', 'switchExecutionWallet'];
vm.runInContext(source.replace('  window.Hookline = {', `  renderBoard = () => {}; renderBoardProfile = () => {}; window.__TradeTest = {${exported.join(',')}};\n  window.Hookline = {`), context);
const ui = context.window.__TradeTest;
const route = ui.parseExecutionRoute(`#/trade/8453/${TOKEN}?side=buy&amount=0.010000000000000001&slippage=75&inputAsset=native`);
assert.equal(route.chainId, 8453); assert.equal(route.tokenAddress, TOKEN); assert.equal(route.amount, '0.010000000000000001'); assert.equal(route.slippageBps, 75);
assert.equal(ui.parseExecutionRoute('#/board'), null);
for (const hash of [
  `#/trade/42161/${TOKEN}`, `#/trade/8453/${ZERO}`, `#/trade/8453/${TOKEN}?side=ape`,
  `#/trade/8453/${TOKEN}?amount=1e9`, `#/trade/8453/${TOKEN}?amount=-1`, `#/trade/8453/${TOKEN}?amount=0`,
  `#/trade/8453/${TOKEN}?slippage=0`, `#/trade/8453/${TOKEN}?slippage=5001`, `#/trade/8453/${TOKEN}?slippage=1&slippage=2`,
  `#/trade/8453/${TOKEN}?side=sell&amount=1&sellPercent=25`, `#/trade/8453/${TOKEN}?sellPercent=50`,
  `#/trade/8453/${TOKEN}?side=sell&sellPercent=101`, `#/trade/8453/${TOKEN}?inputAsset=native`,
  `#/trade/8453/${TOKEN}?side=sell&amount=1&inputAsset=native`, `#/trade/8453/${TOKEN}?taker=${A}`, `#/trade/8453/${TOKEN}?sign=true`,
]) assert.throws(() => ui.parseExecutionRoute(hash), hash);
assert.equal(ui.parseExecutionRoute(`#/trade/56/${TOKEN}?side=sell&sellPercent=100`).sellPercent, 100);

const item = { id: `8453_${HOOK}`, chainId: 8453, chainName: 'Base', address: HOOK };
const relationship = { chainId: 8453, hookId: item.id, hookAddress: HOOK, poolId: `8453_${POOL}` };
const market = { chainId: 'base', pairAddress: POOL, baseToken: { address: TOKEN, symbol: 'TOKEN' }, quoteToken: { address: ZERO, symbol: 'ETH' }, priceUsd: 1 };
assert.equal(ui.relationshipMatchesTrade(relationship, route), true);
assert.equal(ui.relationshipMatchesTrade({ ...relationship, chainId: 1 }, route), false);
assert.equal(ui.relationshipMatchesTrade({ ...relationship, hookId: `1_${HOOK}` }, route), false);
assert.equal(ui.relationshipMatchesTrade({ ...relationship, poolId: `1_${POOL}` }, route), false);
assert.equal(ui.marketForTrade(item, market, relationship, route), market);
assert.equal(ui.marketForTrade({ ...item, chainId: 1 }, market, relationship, route), null);
assert.equal(ui.marketForTrade(item, { ...market, chainId: 'ethereum' }, relationship, route), null);
assert.equal(ui.marketForTrade(item, { ...market, pairAddress: `0x${'6'.repeat(64)}` }, relationship, route), null);
assert.equal(ui.marketForTrade(item, { ...market, baseToken: { address: OTHER, symbol: 'OTHER' } }, relationship, route), null);
assert.equal(ui.marketForTrade(item, { ...market, quoteToken: { address: OTHER, symbol: 'WETH' } }, relationship, route), null, 'Native amount must not silently become wrapped/token units.');
assert.equal(ui.marketForTrade(item, { ...market, quoteToken: { symbol: 'ETH' } }, relationship, route), null, 'A ticker alone does not prove a native asset.');
const reversed = ui.marketForTrade(item, { ...market, baseToken: market.quoteToken, quoteToken: market.baseToken }, relationship, route);
assert.equal(reversed.baseToken.address, TOKEN); assert.equal(reversed.quoteToken.address, ZERO);

assert.equal(ui.exactBalancePercent('3', 18, 50), '0.000000000000000001');
assert.equal(ui.exactBalancePercent('123456789012345678901234567891', 18, 25), '30864197253.086419725308641972');
assert.equal(ui.exactBalancePercent('123', 0, 100), '123');
for (const args of [['0', 18, 50], ['1', 18, 1], ['-1', 18, 50], ['3', 18, 101], ['3', 37, 50]]) assert.throws(() => ui.exactBalancePercent(...args));
const preferences = ui.normalizeExecutionPreferences({ slippageBps: 9000, buyPresets: ['0.01', '-4', '0.01', '1e5'], sellPresets: [0, 25, 25, 101, 100] });
assert.equal(preferences.slippageBps, 50); assert.equal(preferences.buyPresets.join(','), '0.01'); assert.equal(preferences.sellPresets.join(','), '25,100');
nodes.get('execution-slippage').value = '0.29'; assert.equal(ui.executionSlippageBps(), 29);
nodes.get('execution-slippage').value = '0.001'; assert.throws(ui.executionSlippageBps);
nodes.get('execution-slippage').value = '0.75';
nodes.get('execution-buy-presets').value = '0.02, 0.1, 0.3'; nodes.get('execution-sell-presets').value = '10, 50, 100';
ui.saveExecutionPreferences(); assert.equal(ui.loadExecutionPreferences().slippageBps, 75); assert.equal(ui.loadExecutionPreferences().buyPresets.join(','), '0.02,0.1,0.3');

ui.state.execution.module = { buildQuoteRequest };
ui.state.execution.item = item; ui.state.execution.market = market; ui.state.execution.side = 'sell'; ui.state.execution.account = A;
ui.state.execution.tokenCache.set(`8453:${TOKEN}`, { decimals: 18 });
await ui.applyExecutionSellPercent(50);
assert.equal(nodes.get('execution-amount').value, '0.000000000000000001');
assert.equal(parseDisplayToBaseUnits(nodes.get('execution-amount').value, 18), '1');
assert.ok(walletCalls.some((call) => call.method === 'eth_call' && call.params[0].to === TOKEN && call.params[0].data.endsWith(A.slice(2))));
assert.ok(walletCalls.every((call) => !call.method.includes('send') && !call.method.includes('sign')));

const capability = { quote_review_enabled: true, fee_collection_enabled: true, cashback_settlement_enabled: true, cashback_mode: 'instant_fee_rebate', effective_fee_bps: 70 };
const response = (body) => ({ ok: true, json: async () => body });
ui.state.board = { items: [item, { ...item, id: `1_${HOOK}`, chainId: 1 }] };
walletCalls.length = 0;
fetcher = async (url) => {
  if (url.startsWith('/api/token-hooks')) return response({ relationships: [{ ...relationship, chainId: 1, hookId: `1_${HOOK}` }, relationship] });
  if (url.startsWith('/api/v3/hook-markets')) { assert.match(url, /chainId=8453/); return response({ markets: [market], observedAt: new Date().toISOString() }); }
  if (url.startsWith('/api/execution/status')) return response({ chains: [capability] });
  throw new Error(`Route must not quote or sign automatically: ${url}`);
};
context.location.hash = `#/trade/8453/${TOKEN}?side=sell&sellPercent=25&slippage=100`;
await ui.openExecutionRoute();
assert.equal(ui.state.execution.item.chainId, 8453); assert.equal(ui.state.execution.side, 'sell'); assert.equal(ui.state.execution.pendingSellPercent, 25);
assert.equal(nodes.get('execution-slippage').value, '1'); assert.equal(nodes.get('execution-amount').value, ''); assert.equal(nodes.get('execution-dialog').open, true);
assert.equal(walletCalls.length, 0, 'Link navigation must not request accounts, switch chains, read balances, or sign.');

// The specific indexed pool can resolve directly even when it is not one of a
// factory's first four markets. Both token addresses still have to be present.
fetcher = async (url) => {
  if (url.startsWith('/api/token-hooks')) return response({ relationships: [{ ...relationship, baseToken: market.baseToken, quoteToken: market.quoteToken }] });
  if (url.startsWith('/api/execution/status')) return response({ chains: [capability] });
  throw new Error(`No broad factory fallback needed: ${url}`);
};
context.location.hash = `#/trade/8453/${TOKEN}?side=buy&amount=0.1&inputAsset=native`;
await ui.openExecutionRoute();
assert.equal(nodes.get('execution-amount').value, '0.1');
assert.equal(ui.state.execution.market.pairAddress, POOL);
assert.equal(walletCalls.length, 0);

// Fresh quotes remain bound to the exact amount, slippage, chain and wallet.
ui.state.execution.side = 'buy'; ui.state.execution.pendingSellPercent = null; ui.state.execution.capability = capability;
nodes.get('execution-amount').value = '0.01'; nodes.get('execution-slippage').value = '0.5';
const before = ui.executionQuoteContext(); nodes.get('execution-slippage').value = '0.6'; assert.notEqual(ui.executionQuoteContext(), before); nodes.get('execution-slippage').value = '0.5';
let releaseQuote;
fetcher = async (url, options) => {
  assert.equal(url, '/api/execution/quote'); const request = JSON.parse(options.body); assert.equal(request.chain_id, 8453); assert.equal(request.taker, A); assert.equal(request.slippage_bps, 50); assert.equal(request.sell_amount, '10000000000000000');
  return new Promise((resolve) => { releaseQuote = resolve; });
};
const pending = ui.requestExecutionQuote();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof releaseQuote, 'function');
nodes.get('execution-amount').value = '0.02';
releaseQuote(response({ quote: { blockers: ['unsupported_route'] } }));
await pending;
assert.equal(ui.state.execution.quote, null); assert.match(nodes.get('execution-message').textContent, /settings changed/);
assert.ok(walletCalls.every((call) => !call.method.includes('send') && !call.method.includes('sign')));

assert.match(html, /Automated orders are not available/);
assert.match(html, /Hook-specific routing is not verified/);
assert.match(html, /Managed by your wallet/);
console.log('Trade preferences UI: strict handoff parsing, chain/token/pool/native-asset binding, exact balance percentages, device preferences, passive navigation, and stale-quote rejection passed.');
