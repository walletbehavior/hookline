import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const artifactUrl = pathToFileURL(resolve(root, 'dist/server/index.js'));
artifactUrl.searchParams.set('test', String(Date.now()));

const originalFetch = globalThis.fetch;
const upstreamCalls = [];
const marketUpstreamCalls = [];
const edgeResponses = new Map();
const originalCaches = globalThis.caches;
globalThis.caches = {
  default: {
    async match(request) {
      const response = edgeResponses.get(String(request.url || request));
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      edgeResponses.set(String(request.url || request), response.clone());
    },
  },
};
const expectedOwner = `0x${'ab'.repeat(20)}`;
const testX402PayTo = `0x${'ef'.repeat(20)}`;
const ponsAddress = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const tokenPoolId = `4663_0x${'79'.repeat(32)}`;
let failedUpstream = null;

function upstreamChainId(url) {
  if (url === 'https://eth.drpc.org') return '0x1';
  if (url === 'https://base-rpc.publicnode.com') return '0x2105';
  if (url === 'https://mainnet.base.org') return '0x2105';
  if (url === 'https://arb1.arbitrum.io/rpc') return '0xa4b1';
  if (url === 'https://robinhood.drpc.org') return '0x1237';
  throw new Error(`unexpected upstream URL: ${url}`);
}

globalThis.fetch = async (url, init = {}) => {
  const urlString = String(url);
  if (urlString === 'https://facilitator.payai.network/supported') {
    return new Response(JSON.stringify({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
      extensions: [],
      signers: { 'eip155:*': [`0x${'cd'.repeat(20)}`] },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (urlString === 'https://www.v4.xyz/api/pools' || urlString.startsWith('https://www.v4.xyz/api/search?')) {
    marketUpstreamCalls.push(urlString);
    return new Response(JSON.stringify({
      Pool: urlString.endsWith('/api/pools') ? [{
        chainId: '4663', hooks: ponsAddress, id: tokenPoolId,
        name: 'AI / USDG - 0%', txCount: '9001', totalValueLockedUSD: '2200000', untrackedVolumeUSD: '310000',
      }] : undefined,
      pools: urlString.includes('/api/search?') ? [{
        chainId: '4663', hooks: ponsAddress, id: tokenPoolId,
        name: 'AI / USDG - 0%', txCount: '9001', totalValueLockedUSD: '2200000',
      }] : undefined,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString === `https://www.v4.xyz/api/pool/${encodeURIComponent(tokenPoolId)}`) {
    marketUpstreamCalls.push(urlString);
    return new Response(JSON.stringify({ Pool: [{
      chainId: '4663', hooks: ponsAddress, id: tokenPoolId,
      name: 'AI / USDG - 0%', txCount: '9001', totalValueLockedUSD: '2200000',
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString.startsWith('https://www.v4.xyz/api/pools-by-hook?')) {
    marketUpstreamCalls.push(urlString);
    const chainId = new URL(urlString).searchParams.get('chainId');
    const robinhood = chainId === '4663';
    return new Response(JSON.stringify({
      Pool: [{
        chainId,
        hooks: `0x${'ab'.repeat(20)}`,
        id: `${chainId}_0x${(robinhood ? '78' : '12').repeat(32)}`,
        name: robinhood ? 'ETH / HOOD - 0%' : 'WETH / TEST - 0.3%',
        txCount: '42',
        volumeUSD: '12000',
        totalValueLockedUSD: '5000',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString.startsWith('https://api.dexscreener.com/latest/dex/pairs/base/')) {
    marketUpstreamCalls.push(urlString);
    return new Response(JSON.stringify({
      pairs: [{
        chainId: 'base',
        dexId: 'uniswap',
        labels: ['v4'],
        url: `https://dexscreener.com/base/0x${'12'.repeat(32)}`,
        pairAddress: `0x${'12'.repeat(32)}`,
        baseToken: { address: `0x${'34'.repeat(20)}`, name: 'Test Token', symbol: 'TEST' },
        quoteToken: { address: `0x${'56'.repeat(20)}`, name: 'Wrapped Ether', symbol: 'WETH' },
        priceUsd: '0.0042',
        priceChange: { h24: 5.5 },
        volume: { h24: 12000 },
        liquidity: { usd: 5000 },
        marketCap: 420000,
        info: {
          websites: [{ url: 'https://example.com', label: 'Website' }],
          socials: [{ url: 'https://x.com/example', type: 'twitter' }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString.startsWith('https://api.dexscreener.com/latest/dex/search/')) {
    marketUpstreamCalls.push(urlString);
    return new Response(JSON.stringify({ pairs: [{
      chainId: 'robinhood', pairAddress: `0x${'79'.repeat(32)}`, labels: ['v4'],
      baseToken: { address: `0x${'12'.repeat(20)}`, name: 'Artificial Inu', symbol: 'AI' },
      quoteToken: { address: `0x${'13'.repeat(20)}`, name: 'Global Dollar', symbol: 'USDG' },
      liquidity: { usd: 2200000 }, volume: { h24: 310000 }, txns: { h24: { buys: 50, sells: 40 } },
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString.startsWith('https://api.dexscreener.com/latest/dex/pairs/robinhood/')) {
    marketUpstreamCalls.push(urlString);
    return new Response(JSON.stringify({
      pairs: [{
        chainId: 'robinhood',
        dexId: 'uniswap',
        labels: ['v4'],
        url: `https://dexscreener.com/robinhood/0x${'78'.repeat(32)}`,
        pairAddress: `0x${'78'.repeat(32)}`,
        baseToken: { address: `0x${'9a'.repeat(20)}`, name: 'Hood Token', symbol: 'HOOD' },
        quoteToken: { address: `0x${'00'.repeat(20)}`, name: 'Ether', symbol: 'ETH' },
        priceUsd: '0.051',
        priceChange: { h24: -3.2 },
        volume: { h24: 88000 },
        liquidity: { usd: 190000 },
        marketCap: 5100000,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlString === failedUpstream) {
    return new Response('upstream unavailable', { status: 503 });
  }

  const payload = JSON.parse(init.body);
  upstreamCalls.push({ url: urlString, payload });

  let result;
  switch (payload.method) {
    case 'eth_chainId':
      result = upstreamChainId(urlString);
      break;
    case 'eth_blockNumber':
      result = '0x100';
      break;
    case 'eth_getCode':
      result = '0x60006000';
      break;
    case 'eth_call':
      result = `0x${'0'.repeat(24)}${expectedOwner.slice(2)}`;
      break;
    case 'web3_clientVersion':
      result = 'hookline-test-client/1.0';
      break;
    default:
      result = '0x1';
  }

  return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { default: worker } = await import(artifactUrl.href);
assert.equal(typeof worker?.fetch, 'function', 'worker must export default.fetch');

let nextIp = 1;

async function request(path, options = {}) {
  return worker.fetch(
    new Request(`https://hookline.example${path}`, options),
    { X402_PAY_TO: testX402PayTo },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

async function rpc(path, body, ip = `198.51.100.${nextIp++}`) {
  const response = await request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

function envelope(method, params, id = 1) {
  return { jsonrpc: '2.0', method, params, id };
}

try {
  const wwwRedirect = await worker.fetch(
    new Request('https://www.hookline.world/network?source=www'),
    {},
    { waitUntil() {}, passThroughOnException() {} }
  );
  assert.equal(wwwRedirect.status, 301);
  assert.equal(wwwRedirect.headers.get('location'), 'https://hookline.world/network?source=www');

  const rootResponse = await request('/');
  assert.equal(rootResponse.status, 200);
  const rootHtml = await rootResponse.text();
  assert.match(rootHtml, /HOOKS ANALYTICS DESK/);
  assert.match(rootHtml, /Free RPC/);
  assert.match(rootHtml, /Watchlists/);
  assert.match(rootHtml, /The hook board\./);
  assert.match(rootHtml, /CROSS-CHAIN HOOK MARKET INTELLIGENCE/);
  assert.match(rootHtml, /Hookline docs/);
  assert.match(rootHtml, /Frequently asked questions/);
  assert.match(rootHtml, /github\.com\/walletbehavior\/hookline/);
  assert.match(rootHtml, /POST \/rpc\/paid/);
  assert.doesNotMatch(rootHtml, /0x11672C8cD5CB3F17364339244826B110Bac0AC91/);
  assert.doesNotMatch(rootHtml, /flaunch\.gg/);
  assert.match(rootHtml, /copy-icon-btn/);
  assert.match(rootHtml, /hook-profile-backdrop/);
  assert.match(rootHtml, /HooklineTradeBot/);
  assert.match(rootHtml, />Velocity</);
  assert.match(rootHtml, /\/assets\/[a-f0-9]{12}\/app\.js/);
  assert.match(rootHtml, /\/assets\/[a-f0-9]{12}\/styles\.css/);
  assert.doesNotMatch(rootHtml, /capacity wallet/i);
  assert.doesNotMatch(rootHtml, /read[- ]only/i);
  assert.doesNotMatch(rootHtml, /\b(beta|sample|demo|simulated)\b/i);

  const versionedAppPath = rootHtml.match(/\/assets\/[a-f0-9]{12}\/app\.js/)[0];
  const appResponse = await request(versionedAppPath);
  assert.equal(appResponse.status, 200);
  assert.match(appResponse.headers.get('cache-control'), /immutable/);
  const appSource = await appResponse.text();
  assert.match(appSource, /hookline:watchlists:v3/);
  assert.match(appSource, /Promise\.all\(\[worker\(\), worker\(\)\]\)/);
  assert.match(appSource, /fetch\('\/metrics'/);
  assert.match(appSource, /hookline:market-cache:v1/);
  assert.match(appSource, /api\/token-hooks/);
  assert.match(appSource, /board-profile-open/);
  assert.match(appSource, /boardVelocity/);
  assert.match(appSource, /delete next\.error/);
  assert.match(appSource, /delete next\.marketError/);
  assert.doesNotMatch(appSource, /FEE_WALLET|strip-copy-fee/);
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/);

  const versionedCssPath = rootHtml.match(/\/assets\/[a-f0-9]{12}\/styles\.css/)[0];
  const cssResponse = await request(versionedCssPath);
  assert.equal(cssResponse.status, 200);
  const cssSource = await cssResponse.text();
  assert.match(cssSource, /body\.board-profile-open \.hook-profile/);
  assert.match(cssSource, /max-height: min\(88dvh, 820px\)/);

  const hookDataResponse = await request('/data/hooks.json');
  assert.equal(hookDataResponse.status, 200);
  assert.match(hookDataResponse.headers.get('cache-control'), /no-store/);
  const hookData = await hookDataResponse.json();
  assert.equal(hookData.schemaVersion, 1);
  assert.ok(hookData.coverage.hookCount >= 1000);
  assert.equal(hookData.coverage.exhaustive, false);
  assert.ok(hookData.coverage.chainCount >= 10);
  assert.ok(hookData.hooks.some((hook) => hook.project?.name === 'CLAUS'));
  assert.ok(hookData.projects.some((project) => project.provenance === 'Hookline researched'));
  assert.ok(hookData.coverage.verifiedIdentityCount >= 300);
  assert.equal(
    hookData.hooks.find((hook) => hook.id === '4663_0xe5e702641ea86f4ae6cc3cdaed2b886f976be044')?.verifiedContract?.name,
    'PonsV2MemeHook'
  );

  const tokenIndexResponse = await request('/data/token-hooks.json');
  assert.equal(tokenIndexResponse.status, 200);
  const tokenIndex = await tokenIndexResponse.json();
  assert.equal(tokenIndex.schemaVersion, 1);
  assert.ok(tokenIndex.coverage.relationships >= 1000);
  assert.equal(tokenIndex.coverage.hooksFailed, 0);

  const defaultTokenHooksResponse = await request('/api/token-hooks');
  assert.equal(defaultTokenHooksResponse.status, 200);
  const defaultTokenHooks = await defaultTokenHooksResponse.json();
  assert.ok(defaultTokenHooks.relationships.length >= 1000);
  assert.equal(defaultTokenHooks.relationships.length, tokenIndex.coverage.relationships);

  const marketsResponse = await request(`/api/hook-markets?chainId=8453&address=0x${'ab'.repeat(20)}`);
  assert.equal(marketsResponse.status, 200);
  assert.equal(marketsResponse.headers.get('x-hookline-cache'), 'MISS');
  const markets = await marketsResponse.json();
  assert.equal(markets.markets.length, 1);
  assert.equal(markets.markets[0].baseToken.symbol, 'TEST');
  assert.equal(markets.markets[0].marketCap, 420000);
  assert.match(markets.markets[0].chartUrl, /^https:\/\/dexscreener\.com\//);

  const marketCallsAfterMiss = marketUpstreamCalls.length;
  const cachedMarketsResponse = await request(`/api/hook-markets?chainId=8453&address=0x${'ab'.repeat(20)}&v=ignored`);
  assert.equal(cachedMarketsResponse.status, 200);
  assert.equal(cachedMarketsResponse.headers.get('x-hookline-cache'), 'HIT');
  assert.equal(marketUpstreamCalls.length, marketCallsAfterMiss);

  const robinhoodMarketsResponse = await request(`/api/hook-markets?chainId=4663&address=0x${'ab'.repeat(20)}`);
  assert.equal(robinhoodMarketsResponse.status, 200);
  const robinhoodMarkets = await robinhoodMarketsResponse.json();
  assert.equal(robinhoodMarkets.markets[0].baseToken.symbol, 'HOOD');
  assert.equal(robinhoodMarkets.markets[0].priceUsd, 0.051);
  assert.equal(robinhoodMarkets.markets[0].priceChange24h, -3.2);
  assert.equal(robinhoodMarkets.markets[0].volume24h, 88000);
  assert.equal(robinhoodMarkets.markets[0].marketCap, 5100000);

  await request(`/api/hook-markets?chainId=4663&address=${ponsAddress.toLowerCase()}`);
  const ponsV4Call = marketUpstreamCalls.find((value) => value.includes(`hookAddress=${encodeURIComponent(ponsAddress)}`));
  assert.ok(ponsV4Call, 'lowercase board addresses must resolve to the indexed checksum address');

  const tokenHooksResponse = await request('/api/token-hooks?q=AI');
  assert.equal(tokenHooksResponse.status, 200);
  assert.equal(tokenHooksResponse.headers.get('x-hookline-cache'), 'MISS');
  const tokenHooks = await tokenHooksResponse.json();
  assert.equal(tokenHooks.relationships.length, 1);
  assert.equal(tokenHooks.relationships[0].hookName, 'PonsV2MemeHook');
  assert.equal(tokenHooks.relationships[0].pairLabel, 'AI / USDG');

  const addressTokenHooksResponse = await request(`/api/token-hooks?q=0x${'12'.repeat(20)}`);
  assert.equal(addressTokenHooksResponse.status, 200);
  const addressTokenHooks = await addressTokenHooksResponse.json();
  assert.equal(addressTokenHooks.source, 'DexScreener + v4.xyz');
  assert.equal(addressTokenHooks.relationships[0].baseToken.symbol, 'AI');

  const healthResponse = await request('/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'live');
  assert.equal(health.transaction_submission_supported, false);

  const metricsResponse = await request('/metrics');
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.supportedChains, 4);
  assert.equal(metrics.healthyChains, 4);
  assert.equal(metrics.baseLatestBlock, 256);
  assert.equal(metrics.chains.length, 4);
  assert.equal(metrics.chains.every((chain) => chain.healthy), true);

  failedUpstream = 'https://base-rpc.publicnode.com';
  const partialMetricsResponse = await request('/metrics');
  assert.equal(partialMetricsResponse.status, 200);
  const partialMetrics = await partialMetricsResponse.json();
  assert.equal(partialMetrics.healthyChains, 4);
  assert.equal(partialMetrics.baseLatestBlock, 256);
  const failedBase = partialMetrics.chains.find((chain) => chain.chainId === 8453);
  assert.equal(failedBase.healthy, true);
  assert.equal(failedBase.blockNumber, 256);
  assert.ok(upstreamCalls.some((call) =>
    call.url === 'https://mainnet.base.org' && call.payload.method === 'eth_blockNumber'));
  failedUpstream = null;

  const docsResponse = await request('/rpc');
  const docs = await docsResponse.json();
  assert.equal(docs.origin, 'https://hookline.example');
  assert.equal(docs.constraints.batchesSupported, false);
  assert.equal(docs.routes.paidRpc, '/rpc/paid');
  assert.equal(docs.routes.hookBoard, '/data/hooks.json');
  assert.match(docs.routes.hookMarkets, /^\/api\/hook-markets/);
  assert.match(docs.routes.tokenHooks, /^\/api\/token-hooks/);
  assert.equal(docs.paidAccess.amountAtomic, '10000');
  assert.equal(docs.paidAccess.network, 'eip155:8453');
  assert.equal('payTo' in docs.paidAccess, false);

  const unpaidResponse = await request('/rpc/paid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope('hookline_chains', [], 40)),
  });
  assert.equal(unpaidResponse.status, 402);
  const paymentRequiredHeader = unpaidResponse.headers.get('Payment-Required');
  assert.ok(paymentRequiredHeader);
  const paymentRequired = JSON.parse(
    Buffer.from(paymentRequiredHeader, 'base64').toString('utf8')
  );
  assert.equal(paymentRequired.x402Version, 2);
  assert.equal(paymentRequired.accepts.length, 1);
  assert.equal(paymentRequired.accepts[0].scheme, 'exact');
  assert.equal(paymentRequired.accepts[0].network, 'eip155:8453');
  assert.equal(
    paymentRequired.accepts[0].asset,
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  );
  assert.equal(paymentRequired.accepts[0].amount, '10000');
  assert.equal(paymentRequired.accepts[0].payTo, testX402PayTo);

  const malformedPaid = await request('/rpc/paid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformedPaid.status, 200);
  assert.equal((await malformedPaid.json()).error.code, -32700);
  assert.equal(malformedPaid.headers.get('Payment-Required'), null);

  const batch = await rpc('/rpc', [envelope('hookline_chains', [], 1)]);
  assert.equal(batch.json.error.code, -32600);
  assert.match(batch.json.error.message, /batch/i);

  const allBitsAddress = `0x${'0'.repeat(36)}3fff`;
  const decoded = await rpc(
    '/rpc',
    envelope('hookline_decodePermissions', [allBitsAddress], 2)
  );
  assert.equal(decoded.json.result.value, 16383);
  assert.equal(decoded.json.result.flags.length, 14);
  assert.equal(decoded.json.result.flags.every((flag) => flag.enabled), true);

  const hookAddress = `0x${'11'.repeat(20)}`;
  const hook = await rpc(
    '/rpc',
    envelope('hookline_getHook', [1, hookAddress], 3)
  );
  assert.equal(hook.json.result.owner, expectedOwner);
  assert.equal(hook.json.result.codeByteLength, 4);
  const ownerCall = upstreamCalls.find((call) => call.payload.method === 'eth_call');
  assert.equal(ownerCall.payload.params[0].data, '0x8da5cb5b');

  const clientVersion = await rpc(
    '/rpc/1',
    envelope('web3_clientVersion', [], 4)
  );
  assert.equal(clientVersion.json.result, 'hookline-test-client/1.0');

  const writeAttempt = await rpc(
    '/rpc/1',
    envelope('eth_sendRawTransaction', ['0x00'], 5)
  );
  assert.equal(writeAttempt.json.error.code, -32601);

  const fullBlock = await rpc(
    '/rpc/1',
    envelope('eth_getBlockByNumber', ['latest', true], 6)
  );
  assert.equal(fullBlock.json.error.code, -32602);
  assert.match(fullBlock.json.error.message, /full transaction details/i);

  const feeHistory = await rpc(
    '/rpc/1',
    envelope('eth_feeHistory', ['0x81', 'latest', []], 7)
  );
  assert.equal(feeHistory.json.error.code, -32602);
  assert.match(feeHistory.json.error.message, /1 to 128/i);

  const rateIp = '203.0.113.77';
  for (let i = 0; i < 60; i++) {
    const allowed = await rpc(
      '/rpc',
      envelope('hookline_chains', [], 100 + i),
      rateIp
    );
    assert.equal(allowed.response.status, 200);
    assert.ok(allowed.json.result);
  }
  const limited = await rpc(
    '/rpc',
    envelope('hookline_chains', [], 999),
    rateIp
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, -32029);
  assert.ok(limited.response.headers.get('Retry-After'));

  console.log('✓ Hookline Worker tests passed');
} finally {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}
