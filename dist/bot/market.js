// ----------------------------------------------------------------------------
// bot/market.js — Market resolution (v4.xyz + DexScreener)
//
// Clean extraction of the Hookline worker's market-resolution functions
// (worker/index.js: resolveHookMarkets, resolveTokenHooks, tokenShape,
// poolsFromDexSearch, DEXSCREENER_CHAIN_SLUGS) and RavenOS token-pair
// normalization (lib/onchain_trade_projection.mjs normalizedTrade).
//
// The bot resolves hook to pools and market data, and token to hook relationships
// from these public indexes. It never calls the RavenOS trading backend as a
// quote router; chain identity comes from bot/chains.js and market data from
// v4.xyz / DexScreener, exactly like the worker.
//
// Extraction provenance:
//   - worker/index.js : resolveHookMarkets, resolveTokenHooks, tokenShape,
//     poolsFromDexSearch, DEXSCREENER_CHAIN_SLUGS, fetchBoundedJson
//   - lib/onchain_trade_projection.mjs: normalizedTrade shape
// ----------------------------------------------------------------------------
'use strict';

import { getChain, DEXSCREENER_CHAIN_SLUGS } from './chains.js';
import { normalizeTokenIdentity } from './wallets.js';

const V4_POOLS_BY_HOOK_URL = 'https://www.v4.xyz/api/pools-by-hook';
const V4_SEARCH_URL = 'https://www.v4.xyz/api/search';
const V4_POOL_URL = 'https://www.v4.xyz/api/pool';
const DEXSCREENER_PAIRS_URL = 'https://api.dexscreener.com/latest/dex/pairs';
const DEXSCREENER_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search';
const MARKET_TIMEOUT_MS = 7000;
const MARKET_MAX_BYTES = 2 * 1024 * 1024;
const MARKET_LIMIT = 8;
const DEXSCREENER_CHAIN_SLUGS_MAP = Object.freeze(DEXSCREENER_CHAIN_SLUGS);
const DEXSLUG_CHAINS = Object.fromEntries(
  Object.entries(DEXSCREENER_CHAIN_SLUGS_MAP).map(([chainId, slug]) => [slug, Number(chainId)])
);

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function poolAddress(pool) {
  const value = typeof pool?.id === 'string' ? pool.id.split('_').pop() : '';
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

function finiteMarketNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeExternalUrl(value, hosts) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    if (hosts && !hosts.includes(parsed.hostname.toLowerCase())) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function fetchBoundedJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Hookline Telegram bot (https://hookline.world)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MARKET_MAX_BYTES) {
      throw new Error('upstream response was too large');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MARKET_MAX_BYTES) {
      throw new Error('upstream response was too large');
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function marketValue(pool, key, fallbackKey) {
  const primary = finiteMarketNumber(pool?.[key]);
  const fallback = finiteMarketNumber(pool?.[fallbackKey]);
  if (primary == null) return fallback;
  if (fallback == null) return primary;
  return Math.max(primary, fallback);
}

function tokenRelationship(pool, dexPair) {
  const chainId = Number(pool?.chainId);
  const hookAddress = String(pool?.hooks || '');
  const hook = Number.isSafeInteger(chainId) && nonzeroHookAddress(hookAddress)
    ? { address: hookAddress } // hook identity resolved by caller when available
    : null;
  if (!hook || typeof pool?.id !== 'string') return null;

  const poolName = String(pool.name || '').slice(0, 140);
  const pairLabel = poolName.split(' - ')[0].trim() || 'Token pair';
  const chainName = getChain(chainId)?.name || `Chain ${chainId}`;
  const baseToken = normalizeTokenIdentity(dexPair?.baseToken);
  const quoteToken = normalizeTokenIdentity(dexPair?.quoteToken);
  return {
    poolId: pool.id,
    poolName,
    pairLabel,
    chainId,
    chainName: chainName.slice(0, 80),
    hookAddress,
    hookNamed: Boolean(pool?.project?.name || pool?.verifiedContract?.name),
    hookName: String(pool?.project?.name || pool?.verifiedContract?.name || '').slice(0, 120),
    baseToken,
    quoteToken,
    transactions: finiteMarketNumber(pool.txCount)
      ?? ((finiteMarketNumber(dexPair?.txns?.h24?.buys) || 0) + (finiteMarketNumber(dexPair?.txns?.h24?.sells) || 0)),
    liquidityUsd: finiteMarketNumber(dexPair?.liquidity?.usd) ?? finiteMarketNumber(pool.totalValueLockedUSD),
    volumeUsd: finiteMarketNumber(dexPair?.volume?.h24) ?? marketValue(pool, 'volumeUSD', 'untrackedVolumeUSD'),
    priceUsd: finiteMarketNumber(dexPair?.priceUsd) ?? finiteMarketNumber(pool.priceUsd),
    priceChangeH24: finiteMarketNumber(dexPair?.priceChange?.h24),
    marketCapUsd: finiteMarketNumber(dexPair?.marketCap),
    fdvUsd: finiteMarketNumber(dexPair?.fdv),
    chartUrl: safeExternalUrl(dexPair?.url, ['dexscreener.com']),
  };
}

function nonzeroHookAddress(value) {
  return ETH_ADDR_RE.test(String(value || '')) && !/^0x0{40}$/i.test(String(value));
}

export async function resolveHookMarkets(chainId, hookAddress) {
  const hexChain = Number(chainId).toString(16);
  const v4Url = new URL(V4_POOLS_BY_HOOK_URL);
  v4Url.searchParams.set('hookAddress', hookAddress.toLowerCase());
  v4Url.searchParams.set('chainId', hexChain);
  const v4Payload = await fetchBoundedJson(v4Url.toString());
  const pools = Array.isArray(v4Payload?.Pool) ? v4Payload.Pool : [];
  const ranked = pools
    .filter((pool) => poolAddress(pool))
    .sort((left, right) =>
      (finiteMarketNumber(right.totalValueLockedUSD) || 0) - (finiteMarketNumber(left.totalValueLockedUSD) || 0) ||
      (finiteMarketNumber(right.volumeUSD) || 0) - (finiteMarketNumber(left.volumeUSD) || 0)
    )
    .slice(0, MARKET_LIMIT);

  let dexPairs = [];
  let dexError = null;
  const dexSlug = DEXSCREENER_CHAIN_SLUGS_MAP[chainId];
  if (dexSlug && ranked.length) {
    try {
      const pairIds = ranked.map(poolAddress).join(',');
      const dexPayload = await fetchBoundedJson(`${DEXSCREENER_PAIRS_URL}/${dexSlug}/${pairIds}`);
      dexPairs = Array.isArray(dexPayload?.pairs) ? dexPayload.pairs : [];
    } catch (error) {
      dexPairs = [];
      dexError = error instanceof Error ? error.message.slice(0, 120) : 'DexScreener request failed';
    }
  }
  const byPool = new Map(dexPairs.map((pair) => [String(pair?.pairAddress || '').toLowerCase(), pair]));
  const markets = ranked.map((pool) => {
    const addressKey = poolAddress(pool);
    const pair = byPool.get(addressKey);
    const fallbackSymbols = String(pool.name || '').split(' - ')[0].split('/').map((value) => value.trim());
    const commonQuotes = new Set(['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC']);
    const reverseFallback = commonQuotes.has(String(fallbackSymbols[0]).toUpperCase())
      && !commonQuotes.has(String(fallbackSymbols[1]).toUpperCase());
    const fallbackBase = reverseFallback ? fallbackSymbols[1] : fallbackSymbols[0];
    const fallbackQuote = reverseFallback ? fallbackSymbols[0] : fallbackSymbols[1];
    return {
      poolId: typeof pool.id === 'string' ? pool.id : null,
      poolName: typeof pool.name === 'string' ? pool.name.slice(0, 140) : null,
      pairAddress: addressKey,
      baseToken: normalizeTokenIdentity(pair?.baseToken) || { address: null, name: fallbackBase || null, symbol: fallbackBase || null },
      quoteToken: normalizeTokenIdentity(pair?.quoteToken) || { address: null, name: fallbackQuote || null, symbol: fallbackQuote || null },
      priceUsd: finiteMarketNumber(pair?.priceUsd) ?? finiteMarketNumber(pool.priceUsd) ?? null,
      priceChangeH24: finiteMarketNumber(pair?.priceChange?.h24) ?? null,
      volumeUsd: finiteMarketNumber(pair?.volume?.h24) ?? marketValue(pool, 'volumeUSD', 'untrackedVolumeUSD'),
      liquidityUsd: finiteMarketNumber(pair?.liquidity?.usd) ?? marketValue(pool, 'totalValueLockedUSD', 'untrackedVolumeUSD'),
      txnsH24: finiteMarketNumber(pair?.txns?.h24?.buys) + finiteMarketNumber(pair?.txns?.h24?.sells),
    };
  });
  return {
    chainId,
    hook: hookAddress.toLowerCase(),
    observedAt: new Date().toISOString(),
    source: dexPairs.length ? 'v4.xyz + DexScreener' : 'v4.xyz',
    dexError,
    totalPoolsReturned: pools.length,
    markets,
  };
}

async function poolsFromDexSearch(query) {
  const payload = await fetchBoundedJson(`${DEXSCREENER_SEARCH_URL}/?q=${encodeURIComponent(query)}`);
  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  const candidates = pairs
    .filter((pair) => {
      const chainId = DEXSLUG_CHAINS[String(pair?.chainId || '').toLowerCase()];
      return Number.isSafeInteger(chainId)
        && /^0x[0-9a-fA-F]{64}$/.test(String(pair?.pairAddress || ''))
        && Array.isArray(pair?.labels)
        && pair.labels.some((label) => String(label).toLowerCase() === 'v4');
    })
    .sort((left, right) => (finiteMarketNumber(right?.liquidity?.usd) || 0) - (finiteMarketNumber(left?.liquidity?.usd) || 0));

  const unique = [];
  const seen = new Set();
  for (const pair of candidates) {
    const chainId = DEXSLUG_CHAINS[String(pair.chainId).toLowerCase()];
    const poolId = `${chainId}_${String(pair.pairAddress).toLowerCase()}`;
    if (seen.has(poolId)) continue;
    seen.add(poolId);
    unique.push({ pair, poolId });
    if (unique.length >= 8) break;
  }

  const details = await Promise.allSettled(
    unique.map(async ({ pair, poolId }) => {
      const poolPayload = await fetchBoundedJson(`${V4_POOL_URL}/${encodeURIComponent(poolId)}`);
      const pool = Array.isArray(poolPayload?.Pool) ? poolPayload.Pool[0] : null;
      return pool ? { pool, pair } : null;
    })
  );
  return details.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
}

export async function resolveTokenHooks(query) {
  if (!query) return { query: null, observedAt: '', source: '', relationships: [] };

  let resolved = [];
  if (ETH_ADDR_RE.test(query)) {
    resolved = await poolsFromDexSearch(query);
  } else {
    try {
      const target = `${V4_SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const payload = await fetchBoundedJson(target);
      const pools = Array.isArray(payload?.pools) ? payload.pools : Array.isArray(payload?.Pool) ? payload.Pool : [];
      resolved = pools.map((pool) => ({ pool, pair: null }));
    } catch (error) {
      resolved = await poolsFromDexSearch(query);
    }
  }

  const relationships = resolved
    .map(({ pool, pair }) => tokenRelationship(pool, pair))
    .filter(Boolean)
    .sort((left, right) =>
      (right.liquidityUsd || 0) - (left.liquidityUsd || 0) || (right.transactions || 0) - (left.transactions || 0)
    )
    .slice(0, 50);
  return {
    query,
    observedAt: new Date().toISOString(),
    source: query && ETH_ADDR_RE.test(query) ? 'DexScreener + v4.xyz' : 'v4.xyz',
    relationships,
  };
}

export async function resolvePoolsByToken(chainId, tokenAddress) {
  const resolved = await resolveTokenHooks(tokenAddress.toLowerCase());
  return resolved.relationships.filter((rel) => rel.chainId === Number(chainId));
}
