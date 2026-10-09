/* ==========================================================================
   Hookline — public JSON-RPC layer for Cloudflare Workers

   This is the maintainable runtime source. The build step
   (scripts/build-hookline-worker.mjs) reads dist/index.html, dist/styles.css,
   dist/app.js, dist/execution-rail.js, dist/hooks.json and dist/token-hooks.json,
   embeds them with JSON.stringify and emits a single
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
import { handleTelegramUpdate, verifyWebhookSecret } from '../bot/index.js';
import { runAlertScan } from '../bot/alert-runner.js';
import { handleProjectsApi, canonicalProjectRegistry, projectContext } from '../projects/api.js';
import { runProjectScan, deliverProjectEvents } from '../projects/evidence.js';
import { recordRuntimeFamilyAppearances,deliverRuntimeFamilyAppearances } from '../projects/mechanisms.js';
import { createProjectRpcPool, createRpcPoolHealth } from '../projects/rpc-pool.js';
import { TelegramClient } from '../bot/bot-api.js';
import { digest as projectDigest } from '../projects/evidence.js';
import { handleAccountsApi, consumeTelegramLink, pruneAccountEphemera } from '../accounts/index.js';
import { createEip1271Verifier } from '../accounts/contract-signatures.js';
import { handleTapeApi, liveTapePoolsForHook, liveTapeSwapFeesForHook,liveTapeActivityForHook, runBaseTapeScan } from '../projects/tape.js';

'use strict';

// ---------------------------------------------------------------------------
// Static assets (public bundle) — injected by scripts/build-hookline-worker.mjs
// via JSON.stringify over dist/index.html, dist/styles.css, dist/app.js,
// dist/execution-rail.js, dist/hooks.json, dist/token-hooks.json and
// dist/runtime-families.json.
// The build script replaces the marker below verbatim with the embedded assets.
// ---------------------------------------------------------------------------
/* @ASSETS-INJECT */

// ---------------------------------------------------------------------------
// Immutable public RPC configuration (centralized — never mutated, never
// URL-driven, never environment-variable-driven).
// ---------------------------------------------------------------------------

const CHAIN_CONFIG = Object.freeze({
  1: {
    name: 'Ethereum',
    code: 'ETH',
    upstream: 'https://ethereum-rpc.publicnode.com',
    fallbackUpstreams: Object.freeze(['https://eth.drpc.org']),
  },
  56: {
    name: 'BNB Chain',
    code: 'BNB',
    upstream: 'https://bsc-dataseed.bnbchain.org',
  },
  8453: {
    name: 'Base',
    code: 'BASE',
    upstream: 'https://mainnet.base.org',
    fallbackUpstreams: Object.freeze(['https://base-rpc.publicnode.com']),
  },
  42161: {
    name: 'Arbitrum One',
    code: 'ARB',
    upstream: 'https://arb1.arbitrum.io/rpc',
    fallbackUpstreams: Object.freeze(['https://arbitrum.drpc.org']),
  },
  4663: {
    name: 'Robinhood Chain',
    code: 'RHB',
    upstream: 'https://rpc.mainnet.chain.robinhood.com',
    fallbackUpstreams: Object.freeze(['https://robinhood.drpc.org']),
  },
});

const SUPPORTED_CHAINS = Object.freeze(
  [...Object.keys(CHAIN_CONFIG)].map((k) => Number(k))
);
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 32 * 1024; // 32 KiB (request body cap)
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB (upstream response cap)
const X402_NETWORK = 'eip155:8453';
const X402_USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const X402_AMOUNT_ATOMIC = '10000';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const V4_POOLS_BY_HOOK_URL = 'https://www.v4.xyz/api/pools-by-hook';
const V4_POOLS_URL = 'https://www.v4.xyz/api/pools';
const V4_SEARCH_URL = 'https://www.v4.xyz/api/search';
const V4_POOL_URL = 'https://www.v4.xyz/api/pool';
const DEXSCREENER_PAIRS_URL = 'https://api.dexscreener.com/latest/dex/pairs';
const DEXSCREENER_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search';
const MARKET_UPSTREAM_TIMEOUT_MS = 7000;
const MARKET_UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
const MARKET_RESULT_LIMIT = 8;
const MARKET_EDGE_CACHE_SECONDS = 10 * 60;
// Bump when the market response shape or fallback rules change so an older
// edge entry cannot mask a just-deployed resolver fix.
const MARKET_CACHE_SCHEMA_VERSION = '5';
const DEXSCREENER_CHAIN_SLUGS = Object.freeze({
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  146: 'sonic',
  480: 'worldchain',
  1868: 'soneium',
  4663: 'robinhood',
  8453: 'base',
  42161: 'arbitrum',
  42220: 'celo',
  43114: 'avalanche',
  57073: 'ink',
  81457: 'blast',
});
const DEXSCREENER_SLUG_CHAINS = Object.freeze(
  Object.fromEntries(Object.entries(DEXSCREENER_CHAIN_SLUGS).map(([chainId, slug]) => [slug, Number(chainId)]))
);

let canonicalHookAddresses;
let indexedHooks;
let tokenIndexSnapshot;
let runtimeIdentityByDeployment;

function ensureHookIndexes() {
  if (!canonicalHookAddresses) {
    canonicalHookAddresses = new Map();
    indexedHooks = new Map();
    try {
      const snapshot = JSON.parse(ASSETS.hooks);
      const hooks = Array.isArray(snapshot?.hooks) ? snapshot.hooks : [];
      hooks.forEach((hook) => {
        if (Number.isSafeInteger(Number(hook?.chainId)) && EVM_ADDRESS_RE.test(String(hook?.address || ''))) {
          const key = `${Number(hook.chainId)}:${String(hook.address).toLowerCase()}`;
          canonicalHookAddresses.set(key, String(hook.address));
          indexedHooks.set(key, hook);
        }
      });
    } catch {
      // The address supplied by the caller remains a valid fallback.
    }
  }
}

function canonicalIndexedHookAddress(chainId, address) {
  ensureHookIndexes();
  return canonicalHookAddresses.get(`${chainId}:${address.toLowerCase()}`) || address;
}

function indexedHook(chainId, address) {
  ensureHookIndexes();
  return indexedHooks.get(`${chainId}:${address.toLowerCase()}`) || null;
}

function indexedRuntimeIdentity(chainId,address) {
  if(!runtimeIdentityByDeployment) {
    runtimeIdentityByDeployment=new Map();
    try {
      const snapshot=JSON.parse(ASSETS.runtimeFamilies),families=new Map((snapshot.families || []).map(family=>[String(family.runtimeFingerprint || '').toLowerCase(),family]));
      for(const deployment of snapshot.deployments || []) {
        const id=String(deployment?.id || '').toLowerCase(),fingerprint=String(deployment?.fingerprint || '').toLowerCase(),family=families.get(fingerprint);
        if(/^[0-9]+_0x[0-9a-f]{40}$/.test(id) && /^[0-9a-f]{64}$/.test(fingerprint) && family) runtimeIdentityByDeployment.set(id,{fingerprint,
          representativeName:typeof family.representativeName==='string'?family.representativeName.slice(0,120):null,
          deploymentCount:Number(family.deploymentCount)||Number(family.deployments?.length)||1});
      }
    } catch {
      // Runtime identity is optional. Never invent one when the snapshot fails.
    }
  }
  return runtimeIdentityByDeployment.get(`${Number(chainId)}_${String(address || '').toLowerCase()}`) || null;
}

function staticTokenIndex() {
  if (!tokenIndexSnapshot) tokenIndexSnapshot = JSON.parse(ASSETS.tokenHooks);
  return tokenIndexSnapshot;
}

export function resolveIndexedAlertIdentity(chainId,address,targetType='hook') {
  const normalized=String(address || '').toLowerCase();
  if(!EVM_ADDRESS_RE.test(normalized) || !Number.isSafeInteger(Number(chainId))) return null;
  if(targetType==='hook') {
    const hook=indexedHook(Number(chainId),normalized);
    const name=hook?.project?.name || hook?.verifiedContract?.name;
    if(typeof name==='string' && name.trim()) return {name:name.trim().slice(0,100),kind:'hook',
      source:hook?.project?.name?hook.project.provenance:hook.verifiedContract.provenance};
    const runtime=indexedRuntimeIdentity(Number(chainId),normalized);
    if(runtime?.representativeName) return {name:`Runtime · ${runtime.representativeName}`.slice(0,100),kind:'hook',source:'Exact runtime-family snapshot'};
  }
  for(const relationship of staticTokenIndex().relationships || []) {
    if(Number(relationship.chainId)!==Number(chainId)) continue;
    if(targetType==='hook' && relationship.hookAddress?.toLowerCase()===normalized && relationship.hookNamed && relationship.hookName)
      return {name:String(relationship.hookName).slice(0,100),kind:'hook',source:'indexed hook identity'};
    if(targetType==='token') for(const token of [relationship.baseToken,relationship.quoteToken]) {
      if(token?.address?.toLowerCase()===normalized && (token.name || token.symbol))
        return {name:String(token.name || token.symbol).slice(0,100),symbol:String(token.symbol || '').slice(0,24),kind:'token',source:'indexed token identity'};
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiting (per-isolate, best effort): 60 POST RPC requests per minute
// per CF-Connecting-IP. The in-memory map is pruned every check and size-bounded.
// ---------------------------------------------------------------------------
const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_RATE_LIMIT_MAP_SIZE = 10_000;
const rateLimitMap = new Map(); // keys: CF-Connecting-IP values

// The 14 canonical Uniswap v4 hook permission flags, in canonical high-bit
// High-bit (bit 13), low-bit (bit 0) order.
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
  '/execution-rail.js': { type: 'application/javascript; charset=utf-8', key: 'executionRail' },
  '/accounts-ui.js': { type: 'application/javascript; charset=utf-8', key: 'accountsUi' },
  '/privy-wallet.js': { type: 'application/javascript; charset=utf-8', key: 'privyWallet' },
  '/data/hooks.json': { type: 'application/json; charset=utf-8', key: 'hooks' },
  '/data/token-hooks.json': { type: 'application/json; charset=utf-8', key: 'tokenHooks' },
  '/data/runtime-families.json': { type: 'application/json; charset=utf-8', key: 'runtimeFamilies' },
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
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://telegram.org; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https://auth.privy.io https://explorer-api.walletconnect.com; font-src 'self'; object-src 'none'; base-uri 'self'; " +
    "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com https://oauth.telegram.org; " +
    "connect-src 'self' https://api.dexscreener.com https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com " +
    "wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://mainnet.base.org https://eth.merkle.io " +
    "https://eth.drpc.org https://bsc-dataseed.bnbchain.org https://arb1.arbitrum.io https://rpc.mainnet.chain.robinhood.com; " +
    "worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; form-action 'self'",
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
          retryable: res.status === 429 || res.status >= 500,
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
      return { error: { code: -32603, message: 'upstream returned invalid JSON', retryable: true } };
    }
    if (isJsonRpcObject(json)) {
      if ('error' in json && json.error) {
        return { error: Object.assign({ code: -32000, retryable: false }, json.error) };
      }
      return { result: json.result };
    }
    return { error: { code: -32603, message: 'upstream response is not JSON-RPC' } };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: { code: -32000, message: `upstream request timed out after ${timeoutMs}ms`, retryable: true } };
    }
    return { error: { code: -32603, message: `upstream error: ${err.message}`, retryable: true } };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callChainUpstream(config, payload, timeoutMs, onFailure=null) {
  const upstreams = [config.upstream, ...(config.fallbackUpstreams || [])];
  let last = null;
  for (const upstream of upstreams) {
    const result = await callUpstream(upstream, payload, timeoutMs);
    if(result.error && onFailure) onFailure(result.error,upstream);
    last = { ...result, upstream };
    if (!result.error || !result.error.retryable) return last;
  }
  return last;
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
    callChainUpstream(cfg, { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }, UPSTREAM_TIMEOUT_MS),
    callChainUpstream(cfg, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 }, UPSTREAM_TIMEOUT_MS),
  ]);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (chainIdRes.error) {
    return {
      chainId,
      chainIdHex: '0x' + chainId.toString(16),
      name: cfg.name,
      upstream: chainIdRes.upstream || cfg.upstream,
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
      upstream: chainIdRes.upstream || cfg.upstream,
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
      upstream: chainIdRes.upstream || cfg.upstream,
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
      upstream: blockRes.upstream || chainIdRes.upstream || cfg.upstream,
      latencyMs: elapsedMs,
      status: 'error',
      errors: [blockRes.error || { code: -32603, message: 'malformed eth_blockNumber response' }],
    };
  }

  return {
    chainId,
    chainIdHex: '0x' + chainIdNum.toString(16),
    name: cfg.name,
    upstream: blockRes.upstream || chainIdRes.upstream || cfg.upstream,
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

  const codeRes = await callChainUpstream(
    cfg,
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
  const probeRes = await callChainUpstream(
    cfg,
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
    upstream: codeRes.upstream || cfg.upstream,
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
  const res = await callChainUpstream(
    cfg,
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
        const res = await callChainUpstream(cfg, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 'metrics-' + idKey }, UPSTREAM_TIMEOUT_MS);
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

async function fetchBoundedJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Hookline market resolver (https://hookline.world)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MARKET_UPSTREAM_MAX_BYTES) {
      throw new Error('upstream response was too large');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MARKET_UPSTREAM_MAX_BYTES) {
      throw new Error('upstream response was too large');
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function finiteMarketNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function poolAddress(pool) {
  const value = typeof pool?.id === 'string' ? pool.id.split('_').pop() : '';
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

function tokenShape(token) {
  if (!token || typeof token !== 'object') return null;
  const address = typeof token.address === 'string' && EVM_ADDRESS_RE.test(token.address) ? token.address : null;
  const name = typeof token.name === 'string' ? token.name.slice(0, 100) : null;
  const symbol = typeof token.symbol === 'string' ? token.symbol.slice(0, 24) : null;
  return address || name || symbol ? { address, name, symbol } : null;
}

function indexedPoolToken(value, label) {
  const raw = typeof value === 'string' ? value.split('_').pop() : '';
  if (!EVM_ADDRESS_RE.test(raw)) return null;
  const address = /^0x0{40}$/i.test(raw) ? EXECUTION_NATIVE_TOKEN : raw.toLowerCase();
  const name = typeof label === 'string' && label ? label.slice(0, 100) : null;
  const symbol = typeof label === 'string' && label ? label.slice(0, 24) : null;
  return { address, name, symbol };
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

function marketProjectLink(info, type) {
  const values = type === 'website' ? info?.websites : info?.socials;
  if (!Array.isArray(values)) return null;
  const candidate = type === 'website'
    ? values.find((entry) => entry && typeof entry.url === 'string')
    : values.find((entry) => entry && ['twitter', 'x'].includes(String(entry.type).toLowerCase()));
  return type === 'website'
    ? safeExternalUrl(candidate?.url)
    : safeExternalUrl(candidate?.url, ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
}

export function advertisedPoolFeeMetadata(poolName) {
  const match = String(poolName || '').match(/-\s*([0-9]+(?:\.[0-9]+)?)%\s*$/);
  const percent=match ? finiteMarketNumber(match[1]) : null;
  // v4's 0x800000 PoolKey sentinel is a dynamic-fee flag, not 838.8608%.
  // This is indexed configuration, never a read of the current swap fee.
  const feeMode=percent===838.8608?'dynamic':percent!==null && percent>=0 && percent<=100?'static':percent===null?'unavailable':'invalid';
  return {advertisedFeePercent:feeMode==='static'?percent:null,feeMode,feeSource:'indexed pool name'};
}

async function resolveHookMarkets(chainId, address) {
  const profile = indexedHook(chainId, address);
  const v4Url = new URL(V4_POOLS_BY_HOOK_URL);
  v4Url.searchParams.set('hookAddress', address);
  v4Url.searchParams.set('chainId', String(chainId));
  const v4Payload = await fetchBoundedJson(v4Url.toString());
  const pools = Array.isArray(v4Payload?.Pool) ? v4Payload.Pool : [];
  const persistentRelationships = pools.length ? [] : (staticTokenIndex().relationships || [])
    .filter((relationship) => Number(relationship?.chainId) === chainId
      && String(relationship?.hookAddress || '').toLowerCase() === address.toLowerCase())
    .slice(0, MARKET_RESULT_LIMIT);
  const candidates = pools.length ? pools : persistentRelationships.map((relationship) => ({
    id: relationship.poolId,
    name: relationship.poolName,
    txCount: relationship.transactions,
    totalValueLockedUSD: relationship.liquidityUsd,
    volumeUSD: relationship.volumeUsd,
    persistentRelationship: relationship,
  }));
  const ranked = candidates
    .filter((pool) => poolAddress(pool))
    .sort((left, right) => (
      (finiteMarketNumber(right.totalValueLockedUSD) || 0) - (finiteMarketNumber(left.totalValueLockedUSD) || 0)
      || (finiteMarketNumber(right.volumeUSD) || 0) - (finiteMarketNumber(left.volumeUSD) || 0)
    ))
    .slice(0, MARKET_RESULT_LIMIT);

  let dexPairs = [];
  let dexError = null;
  const dexSlug = DEXSCREENER_CHAIN_SLUGS[chainId];
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
    const persistent = pool.persistentRelationship;
    const fallbackSymbols = String(pool.name || '').split(' - ')[0].split('/').map((value) => value.trim());
    const commonQuotes = new Set(['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC']);
    const reverseFallback = commonQuotes.has(String(fallbackSymbols[0]).toUpperCase())
      && !commonQuotes.has(String(fallbackSymbols[1]).toUpperCase());
    const fallbackBase = reverseFallback ? fallbackSymbols[1] : fallbackSymbols[0];
    const fallbackQuote = reverseFallback ? fallbackSymbols[0] : fallbackSymbols[1];
    const indexedBase = indexedPoolToken(reverseFallback ? pool.token1 : pool.token0, fallbackBase);
    const indexedQuote = indexedPoolToken(reverseFallback ? pool.token0 : pool.token1, fallbackQuote);
    return {
      poolId: typeof pool.id === 'string' ? pool.id : null,
      poolName: typeof pool.name === 'string' ? pool.name.slice(0, 140) : null,
      ...advertisedPoolFeeMetadata(pool.name),
      pairAddress: addressKey,
      baseToken: tokenShape(pair?.baseToken) || tokenShape(persistent?.baseToken) || indexedBase || { address: null, name: fallbackBase || null, symbol: fallbackBase || null },
      quoteToken: tokenShape(pair?.quoteToken) || tokenShape(persistent?.quoteToken) || indexedQuote || { address: null, name: fallbackQuote || null, symbol: fallbackQuote || null },
      dexLabel: pair?.dexId === 'uniswap' ? `Uniswap ${Array.isArray(pair.labels) && pair.labels[0] ? pair.labels[0] : ''}`.trim() : String(pair?.dexId || 'Uniswap v4').slice(0, 40),
      priceUsd: finiteMarketNumber(pair?.priceUsd),
      priceChange24h: finiteMarketNumber(pair?.priceChange?.h24),
      volume24h: finiteMarketNumber(pair?.volume?.h24) ?? finiteMarketNumber(persistent?.volumeUsd),
      liquidityUsd: finiteMarketNumber(pair?.liquidity?.usd) ?? finiteMarketNumber(pool.totalValueLockedUSD) ?? finiteMarketNumber(persistent?.liquidityUsd),
      marketCap: finiteMarketNumber(pair?.marketCap) ?? finiteMarketNumber(pair?.fdv),
      transactions: finiteMarketNumber(pool.txCount),
      chartUrl: safeExternalUrl(pair?.url, ['dexscreener.com', 'www.dexscreener.com'])
        || safeExternalUrl(persistent?.chartUrl, ['dexscreener.com', 'www.dexscreener.com'])
        || `https://www.v4.xyz/pool/${encodeURIComponent(pool.id)}`,
      website: marketProjectLink(pair?.info, 'website'),
      x: marketProjectLink(pair?.info, 'x'),
    };
  });
  return {
    chainId,
    hook: address,
    profile: profile ? {
      id: profile.id,
      chainId: profile.chainId,
      chainName: profile.chainName,
      address: profile.address,
      numberOfPools: profile.numberOfPools,
      numberOfSwaps: profile.numberOfSwaps,
      project: profile.project || null,
      verifiedContract: profile.verifiedContract || null,
      runtime: indexedRuntimeIdentity(chainId,address),
    } : null,
    observedAt: new Date().toISOString(),
    source: persistentRelationships.length
      ? dexPairs.length ? 'persistent index + DexScreener' : 'persistent index'
      : dexPairs.length ? 'v4.xyz + DexScreener' : 'v4.xyz',
    dexError,
    totalPoolsReturned: candidates.length,
    markets,
  };
}

function hookDisplayName(hook, address) {
  return String(hook?.project?.name || hook?.verifiedContract?.name || `Hook ${address.slice(0, 8)}…${address.slice(-6)}`).slice(0, 120);
}

function nonzeroHookAddress(value) {
  return EVM_ADDRESS_RE.test(String(value || '')) && !/^0x0{40}$/i.test(String(value));
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
    ? indexedHook(chainId, hookAddress)
    : null;
  if (!hook || typeof pool?.id !== 'string') return null;

  const poolName = String(pool.name || '').slice(0, 140);
  const pairLabel = poolName.split(' - ')[0].trim() || 'Token pair';
  const baseToken = tokenShape(dexPair?.baseToken);
  const quoteToken = tokenShape(dexPair?.quoteToken);
  return {
    poolId: pool.id,
    poolName,
    pairLabel,
    chainId,
    chainName: String(hook.chainName || CHAIN_CONFIG[chainId]?.name || `Chain ${chainId}`).slice(0, 80),
    hookId: hook.id,
    hookAddress: hook.address,
    hookName: hookDisplayName(hook, hook.address),
    hookNamed: Boolean(hook.project?.name || hook.verifiedContract?.name),
    baseToken,
    quoteToken,
    transactions: finiteMarketNumber(pool.txCount)
      ?? finiteMarketNumber(dexPair?.txns?.h24?.buys) + finiteMarketNumber(dexPair?.txns?.h24?.sells),
    liquidityUsd: finiteMarketNumber(dexPair?.liquidity?.usd) ?? finiteMarketNumber(pool.totalValueLockedUSD),
    volumeUsd: finiteMarketNumber(dexPair?.volume?.h24) ?? marketValue(pool, 'volumeUSD', 'untrackedVolumeUSD'),
  };
}

async function poolsFromDexSearch(query) {
  const payload = await fetchBoundedJson(`${DEXSCREENER_SEARCH_URL}/?q=${encodeURIComponent(query)}`);
  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  const candidates = pairs
    .filter((pair) => {
      const chainId = DEXSCREENER_SLUG_CHAINS[String(pair?.chainId || '').toLowerCase()];
      return Number.isSafeInteger(chainId)
        && /^0x[0-9a-fA-F]{64}$/.test(String(pair?.pairAddress || ''))
        && Array.isArray(pair?.labels)
        && pair.labels.some((label) => String(label).toLowerCase() === 'v4');
    })
    .sort((left, right) => (finiteMarketNumber(right?.liquidity?.usd) || 0) - (finiteMarketNumber(left?.liquidity?.usd) || 0));

  const unique = [];
  const seen = new Set();
  for (const pair of candidates) {
    const chainId = DEXSCREENER_SLUG_CHAINS[String(pair.chainId).toLowerCase()];
    const poolId = `${chainId}_${String(pair.pairAddress).toLowerCase()}`;
    if (seen.has(poolId)) continue;
    seen.add(poolId);
    unique.push({ pair, poolId });
    if (unique.length >= 8) break;
  }

  const details = await Promise.allSettled(unique.map(async ({ pair, poolId }) => {
    const poolPayload = await fetchBoundedJson(`${V4_POOL_URL}/${encodeURIComponent(poolId)}`);
    const pool = Array.isArray(poolPayload?.Pool) ? poolPayload.Pool[0] : null;
    return pool ? { pool, pair } : null;
  }));
  return details.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
}

async function resolveTokenHooks(query) {
  if (!query) {
    const snapshot = staticTokenIndex();
    return {
      query: null,
      observedAt: snapshot.generatedAt,
      source: snapshot.source,
      coverage: snapshot.coverage,
      relationships: Array.isArray(snapshot.relationships) ? snapshot.relationships : [],
    };
  }

  let resolved = [];
  if (EVM_ADDRESS_RE.test(query)) {
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
    .sort((left, right) => (
      (right.liquidityUsd || 0) - (left.liquidityUsd || 0)
      || (right.transactions || 0) - (left.transactions || 0)
    ))
    .slice(0, 50);
  return {
    query,
    observedAt: new Date().toISOString(),
    source: query && EVM_ADDRESS_RE.test(query) ? 'DexScreener + v4.xyz' : 'v4.xyz',
    relationships,
  };
}

// Health and documentation endpoints.
// ---------------------------------------------------------------------------

function jsonHealthBody() {
  return {
    name: 'hookline',
    version: '0.1.0',
    status: 'live',
    mode: 'worker',
    transaction_submission_supported: true,
    transaction_submission_location: 'user_wallet',
    server_transaction_submission_supported: false,
    public_rpc_transaction_submission_supported: false,
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
    transaction_submission_supported: true,
    transaction_submission_location: 'user_wallet',
    server_transaction_submission_supported: false,
    public_rpc_transaction_submission_supported: false,
    origin: origin,
    routes: {
      rpcRoot: '/rpc',
      paidRpc: '/rpc/paid',
      metrics: '/metrics',
      health: '/health',
      hookBoard: '/data/hooks.json',
      runtimeFamilies: '/data/runtime-families.json',
      hookMarkets: '/api/v3/hook-markets?chainId={chainId}&address={hookAddress}',
      tokenHooks: '/api/token-hooks?q={tokenNameSymbolOrAddress}',
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
      browser_wallet_submission_supported: EXECUTION_CHAIN_SET.has(Number(idKey)),
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
        path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'false',
    },
    SECURITY_HEADERS
  );
  return new Response(content, { status: 200, headers });
}

function handleStaticAsset(path) {
  const versionedAsset = path.match(/^\/assets\/[a-f0-9]{12}\/(styles\.css|app\.js|execution-rail\.js|accounts-ui\.js|privy-wallet\.js)$/);
  const routePath = versionedAsset ? `/${versionedAsset[1]}` : path;
  const route = STATIC_ROUTES[routePath];
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
let paidRpcPayTo;

function getPaidRpcApp(payTo) {
  if (paidRpcApp && paidRpcPayTo === payTo) return paidRpcApp;

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
            payTo,
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
  paidRpcPayTo = payTo;
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

const EXECUTION_CHAIN_IDS = Object.freeze([1, 56, 4663, 8453]);
const EXECUTION_CHAIN_SET = new Set(EXECUTION_CHAIN_IDS);
const EXECUTION_BODY_BYTES = 12 * 1024;
const EXECUTION_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function executionJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
  });
}

async function readExecutionOrder(request) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('content_type_invalid'), { status: 415 });
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > EXECUTION_BODY_BYTES) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > EXECUTION_BODY_BYTES) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw Object.assign(new Error('request_json_invalid'), { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('request_object_required'), { status: 400 });
  }
  const allowed = new Set(['chain_id', 'sell_token', 'buy_token', 'sell_amount', 'taker', 'slippage_bps']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error('request_field_invalid'), { status: 400 });
  }
  const chainId = Number(body.chain_id);
  const sellToken = String(body.sell_token || '').toLowerCase();
  const buyToken = String(body.buy_token || '').toLowerCase();
  const taker = String(body.taker || '').toLowerCase();
  const sellAmount = String(body.sell_amount || '');
  const slippageBps = Number(body.slippage_bps);
  if (!EXECUTION_CHAIN_SET.has(chainId)) throw Object.assign(new Error('chain_not_supported'), { status: 400 });
  if (!EVM_ADDRESS_RE.test(sellToken) || /^0x0{40}$/.test(sellToken)) throw Object.assign(new Error('sell_token_invalid'), { status: 400 });
  if (!EVM_ADDRESS_RE.test(buyToken) || /^0x0{40}$/.test(buyToken)) throw Object.assign(new Error('buy_token_invalid'), { status: 400 });
  if (sellToken === buyToken) throw Object.assign(new Error('token_pair_invalid'), { status: 400 });
  if (!EVM_ADDRESS_RE.test(taker) || /^0x0{40}$/.test(taker)) throw Object.assign(new Error('taker_invalid'), { status: 400 });
  if (!/^[1-9][0-9]{0,77}$/.test(sellAmount)) throw Object.assign(new Error('sell_amount_invalid'), { status: 400 });
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) {
    throw Object.assign(new Error('slippage_invalid'), { status: 400 });
  }
  return {
    chain_id: chainId,
    sell_token: sellToken,
    buy_token: buyToken,
    sell_amount: sellAmount,
    taker,
    slippage_bps: slippageBps,
  };
}

function publicExecutionQuote(quote) {
  const fee = quote?.fee && typeof quote.fee === 'object' ? {
    enabled: quote.fee.enabled === true,
    state: String(quote.fee.state || ''),
    amount: String(quote.fee.amount || '0'),
    token: quote.fee.token || null,
    fee_bps: Number(quote.fee.fee_bps || 0),
    amount_verification: String(quote.fee.amount_verification || ''),
  } : null;
  return {
    schema_version: 'hookline.execution_quote.v1',
    state: String(quote?.state || ''),
    chain_id: Number(quote?.chain_id),
    observed_at: quote?.observed_at || null,
    expires_at: quote?.expires_at || null,
    exact_binding: quote?.exact_binding || null,
    fee,
    allowance: quote?.allowance || null,
    provider_issues: quote?.provider_issues || null,
    blockers: Array.isArray(quote?.blockers) ? quote.blockers : [],
    total_network_fee_native_base_units: quote?.total_network_fee_native_base_units || null,
    token_taxes: quote?.token_taxes || null,
    route: quote?.route || null,
    unsigned_transaction: quote?.unsigned_transaction || null,
    wallet_handoff_eligible: quote?.wallet_handoff_eligible === true,
  };
}

const EXECUTION_GROSS_FEE_BPS = 100;
const EXECUTION_CASHBACK_BPS = 30;
const EXECUTION_EFFECTIVE_FEE_BPS = 70;
const EXECUTION_INTENT_PREFIX = 'hxi_';
const EXECUTION_INTENT_MAX_TTL_MS = 2 * 60 * 1000;
const EXECUTION_TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const EXECUTION_DATA_RE = /^0x(?:[0-9a-f]{2})*$/;

function executionAmount(value, field, { positive = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized) || (positive && normalized === '0')) {
    throw Object.assign(new Error(`${field}_invalid`), { status: 503 });
  }
  return BigInt(normalized).toString();
}

function executionHexData(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!EXECUTION_DATA_RE.test(normalized)) {
    throw Object.assign(new Error(`${field}_invalid`), { status: 503 });
  }
  return normalized;
}

function executionAddress(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(normalized) || /^0x0{40}$/.test(normalized)) {
    throw Object.assign(new Error(`${field}_invalid`), { status: 503 });
  }
  return normalized;
}

function bpsAmount(amount, bps) {
  return ((BigInt(executionAmount(amount, 'execution_notional', { positive: true })) * BigInt(bps)) / 10000n).toString();
}

async function createExecutionIntent(order, quote, db, now = Date.now()) {
  if (!db?.prepare) throw Object.assign(new Error('execution_ledger_unavailable'), { status: 503 });
  const transaction = quote?.unsigned_transaction;
  const binding = quote?.exact_binding;
  const fee = quote?.fee;
  const expiresAt = Date.parse(String(quote?.expires_at || ''));
  if (quote?.state !== 'awaiting_wallet_signature' || quote?.wallet_handoff_eligible !== true || !transaction || !binding) {
    throw Object.assign(new Error('execution_quote_not_eligible'), { status: 503 });
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > EXECUTION_INTENT_MAX_TTL_MS) {
    throw Object.assign(new Error('execution_quote_expiry_invalid'), { status: 503 });
  }
  const taker = executionAddress(order.taker, 'execution_taker');
  const transactionFrom = executionAddress(transaction.from, 'execution_transaction_from');
  const transactionTo = executionAddress(transaction.to, 'execution_transaction_to');
  if (transactionFrom !== taker || executionAddress(binding.taker, 'execution_binding_taker') !== taker) {
    throw Object.assign(new Error('execution_wallet_binding_mismatch'), { status: 503 });
  }
  const transactionChainId = Number(transaction.chain_id ?? transaction.chainId ?? order.chain_id);
  if (transactionChainId !== Number(order.chain_id) || Number(quote.chain_id) !== Number(order.chain_id)) {
    throw Object.assign(new Error('execution_chain_binding_mismatch'), { status: 503 });
  }
  const data = executionHexData(transaction.data, 'execution_transaction_data');
  const value = executionAmount(transaction.value ?? '0', 'execution_transaction_value');
  const feeToken = executionAddress(fee?.token, 'execution_fee_token');
  const effectiveFeeAmount = bpsAmount(order.sell_amount, EXECUTION_EFFECTIVE_FEE_BPS);
  const grossFeeAmount = bpsAmount(order.sell_amount, EXECUTION_GROSS_FEE_BPS);
  const cashbackAmount = bpsAmount(order.sell_amount, EXECUTION_CASHBACK_BPS);
  if (fee?.enabled !== true
    || Number(fee.fee_bps) !== EXECUTION_EFFECTIVE_FEE_BPS
    || feeToken !== String(order.sell_token).toLowerCase()
    || executionAmount(fee.amount, 'execution_fee_amount') !== effectiveFeeAmount) {
    throw Object.assign(new Error('instant_cashback_quote_mismatch'), { status: 503 });
  }
  if (BigInt(grossFeeAmount) - BigInt(cashbackAmount) !== BigInt(effectiveFeeAmount)) {
    throw Object.assign(new Error('instant_cashback_math_mismatch'), { status: 503 });
  }
  const intentId = `${EXECUTION_INTENT_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
  const dataHash = await sha256HexOfHex(data);
  await db.prepare(`INSERT INTO execution_intents
    (intent_id, chain_id, taker_address, transaction_to, transaction_data_hash, transaction_value,
     expires_at, fee_token, gross_fee_amount, cashback_amount, effective_fee_amount,
     gross_fee_bps, cashback_bps, effective_fee_bps, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(intentId, Number(order.chain_id), taker, transactionTo, dataHash, value, expiresAt,
      feeToken, grossFeeAmount, cashbackAmount, effectiveFeeAmount,
      EXECUTION_GROSS_FEE_BPS, EXECUTION_CASHBACK_BPS, EXECUTION_EFFECTIVE_FEE_BPS, now)
    .run();
  return Object.freeze({
    intent_id: intentId,
    expires_at: new Date(expiresAt).toISOString(),
    fee: Object.freeze({
      gross_fee_bps: EXECUTION_GROSS_FEE_BPS,
      cashback_bps: EXECUTION_CASHBACK_BPS,
      effective_fee_bps: EXECUTION_EFFECTIVE_FEE_BPS,
      cashback_mode: 'instant_fee_rebate',
      token: feeToken,
      gross_amount: grossFeeAmount,
      cashback_amount: cashbackAmount,
      effective_amount: effectiveFeeAmount,
    }),
  });
}

async function readExecutionReceiptRequest(request) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('content_type_invalid'), { status: 415 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 2048) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw Object.assign(new Error('request_json_invalid'), { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['intent_id', 'transaction_hash'].includes(key))) {
    throw Object.assign(new Error('request_field_invalid'), { status: 400 });
  }
  const intentId = String(body.intent_id || '').trim();
  const transactionHash = String(body.transaction_hash || '').trim().toLowerCase();
  if (!/^hxi_[0-9a-f]{32}$/.test(intentId)) throw Object.assign(new Error('intent_id_invalid'), { status: 400 });
  if (!EXECUTION_TX_HASH_RE.test(transactionHash)) throw Object.assign(new Error('transaction_hash_invalid'), { status: 400 });
  return { intentId, transactionHash };
}

function rpcQuantityToDecimal(value, field) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) {
    throw Object.assign(new Error(`${field}_invalid`), { status: 503 });
  }
  return BigInt(normalized).toString();
}

function publicExecutionReceipt(row) {
  return Object.freeze({
    schema_version: 'hookline.execution_receipt.v1',
    state: 'confirmed',
    intent_id: row.intent_id,
    transaction_hash: row.transaction_hash,
    chain_id: Number(row.chain_id),
    taker: row.taker_address,
    block_number: row.block_number,
    confirmed_at: new Date(Number(row.confirmed_at)).toISOString(),
    fee: Object.freeze({
      token: row.fee_token,
      gross_fee_bps: EXECUTION_GROSS_FEE_BPS,
      cashback_bps: EXECUTION_CASHBACK_BPS,
      effective_fee_bps: EXECUTION_EFFECTIVE_FEE_BPS,
      cashback_mode: 'instant_fee_rebate',
      gross_amount: row.gross_fee_amount,
      cashback_amount: row.cashback_amount,
      effective_amount: row.effective_fee_amount,
    }),
  });
}

async function reconcileExecutionReceipt(input, env, now = Date.now()) {
  if (!env?.DB?.prepare) throw Object.assign(new Error('execution_ledger_unavailable'), { status: 503 });
  const intent = await env.DB.prepare('SELECT * FROM execution_intents WHERE intent_id = ? LIMIT 1')
    .bind(input.intentId).first();
  if (!intent) throw Object.assign(new Error('execution_intent_not_found'), { status: 404 });
  if (intent.transaction_hash && intent.transaction_hash !== input.transactionHash) {
    throw Object.assign(new Error('execution_intent_already_consumed'), { status: 409 });
  }
  const existing = await env.DB.prepare('SELECT * FROM execution_receipts WHERE intent_id = ? OR transaction_hash = ? LIMIT 1')
    .bind(input.intentId, input.transactionHash).first();
  if (existing) {
    if (existing.intent_id !== input.intentId || existing.transaction_hash !== input.transactionHash) {
      throw Object.assign(new Error('execution_receipt_conflict'), { status: 409 });
    }
    return publicExecutionReceipt(existing);
  }
  const config = CHAIN_CONFIG[Number(intent.chain_id)];
  if (!config || !EXECUTION_CHAIN_SET.has(Number(intent.chain_id))) {
    throw Object.assign(new Error('execution_chain_not_supported'), { status: 400 });
  }
  const [transactionResult, receiptResult] = await Promise.all([
    callChainUpstream(config, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [input.transactionHash] }, UPSTREAM_TIMEOUT_MS),
    callChainUpstream(config, { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [input.transactionHash] }, UPSTREAM_TIMEOUT_MS),
  ]);
  const transaction = transactionResult?.result;
  const receipt = receiptResult?.result;
  if (transactionResult?.error || receiptResult?.error) throw Object.assign(new Error('execution_receipt_rpc_failed'), { status: 503 });
  if (!transaction || !receipt) throw Object.assign(new Error('execution_receipt_pending'), { status: 409 });
  if (String(receipt.status).toLowerCase() !== '0x1') throw Object.assign(new Error('execution_transaction_failed'), { status: 409 });
  if (String(transaction.hash || '').toLowerCase() !== input.transactionHash
    || String(receipt.transactionHash || '').toLowerCase() !== input.transactionHash
    || executionAddress(transaction.from, 'execution_receipt_from') !== intent.taker_address
    || executionAddress(transaction.to, 'execution_receipt_to') !== intent.transaction_to
    || executionAddress(receipt.from, 'execution_receipt_log_from') !== intent.taker_address
    || executionAddress(receipt.to, 'execution_receipt_log_to') !== intent.transaction_to
    || (transaction.blockNumber && rpcQuantityToDecimal(transaction.blockNumber, 'execution_transaction_block')
      !== rpcQuantityToDecimal(receipt.blockNumber, 'execution_receipt_block'))
    || (transaction.chainId && Number(BigInt(transaction.chainId)) !== Number(intent.chain_id))
    || rpcQuantityToDecimal(transaction.value, 'execution_receipt_value') !== intent.transaction_value
    || await sha256HexOfHex(executionHexData(transaction.input ?? transaction.data, 'execution_receipt_data')) !== intent.transaction_data_hash) {
    throw Object.assign(new Error('execution_receipt_binding_mismatch'), { status: 409 });
  }
  const blockNumber = rpcQuantityToDecimal(receipt.blockNumber, 'execution_receipt_block');
  const changed = await env.DB.prepare(`UPDATE execution_intents
    SET consumed_at = ?, transaction_hash = ?
    WHERE intent_id = ? AND (transaction_hash IS NULL OR transaction_hash = ?)`)
    .bind(now, input.transactionHash, input.intentId, input.transactionHash).run();
  if (Number(changed?.meta?.changes ?? changed?.changes ?? 0) < 1) {
    throw Object.assign(new Error('execution_intent_already_consumed'), { status: 409 });
  }
  await env.DB.prepare(`INSERT INTO execution_receipts
    (transaction_hash, intent_id, chain_id, taker_address, block_number, fee_token,
     gross_fee_amount, cashback_amount, effective_fee_amount, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_hash) DO NOTHING`)
    .bind(input.transactionHash, input.intentId, Number(intent.chain_id), intent.taker_address,
      blockNumber, intent.fee_token, intent.gross_fee_amount, intent.cashback_amount,
      intent.effective_fee_amount, now).run();
  const stored = await env.DB.prepare('SELECT * FROM execution_receipts WHERE transaction_hash = ? LIMIT 1')
    .bind(input.transactionHash).first();
  if (!stored || stored.intent_id !== input.intentId) {
    throw Object.assign(new Error('execution_receipt_conflict'), { status: 409 });
  }
  return publicExecutionReceipt(stored);
}

async function readExecutionTokenMetadata(chainId, address, env) {
  if (address === EXECUTION_NATIVE_TOKEN) {
    const symbols = { 1: 'ETH', 56: 'BNB', 4663: 'ETH', 8453: 'ETH' };
    return { chain_id: chainId, token_address: address, decimals: 18, native: true, symbol: symbols[chainId], balance_base_units: null };
  }
  const config = CHAIN_CONFIG[chainId];
  if (!config) return env.RAVENOS_EXECUTION.tokenMetadata(chainId, address, null);
  const chain = await callChainUpstream(config, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, UPSTREAM_TIMEOUT_MS);
  if (chain.error || hexToInt(chain.result) !== chainId) throw new Error('token_rpc_chain_mismatch');
  const [code, decimals] = await Promise.all([
    callChainUpstream(config, { jsonrpc: '2.0', id: 2, method: 'eth_getCode', params: [address, 'latest'] }, UPSTREAM_TIMEOUT_MS),
    callChainUpstream(config, { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] }, UPSTREAM_TIMEOUT_MS),
  ]);
  if (code.error || !/^0x[0-9a-f]+$/i.test(String(code.result || '')) || ['0x', '0x0'].includes(String(code.result).toLowerCase())) {
    throw new Error('token_contract_unavailable');
  }
  const precision = hexToInt(decimals.result);
  if (decimals.error || !Number.isSafeInteger(precision) || precision < 0 || precision > 36) throw new Error('token_decimals_invalid');
  return { chain_id: chainId, token_address: address, decimals: precision, native: false, symbol: null, balance_base_units: null };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

const projectRpcHealth=createRpcPoolHealth();
const tapeRpcHealth=createRpcPoolHealth();
const verifySmartWalletSignature=createEip1271Verifier({allowedChains:SUPPORTED_CHAINS,rpc:async({chainId,method,params,signal})=>{
  const config=CHAIN_CONFIG[chainId];
  if(!config || !['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method)) throw new Error('Unsupported verification read.');
  const response=await fetch(config.upstream,{method:'POST',redirect:'manual',signal,
    headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(!response.ok || Number(response.headers.get('content-length'))>1024*1024 || !response.body) throw new Error('Signature verification provider unavailable.');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done) break;bytes+=value.byteLength;
      if(bytes>1024*1024) {await reader.cancel();throw new Error('Verification response exceeded limit.');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  const payload=JSON.parse(new TextDecoder().decode(buffer));
  if(payload.error) throw Object.assign(new Error(String(payload.error.message || 'RPC verification failed.')),{code:payload.error.code});
  if(payload.jsonrpc!=='2.0' || payload.id!==1 || !Object.hasOwn(payload,'result')) throw new Error('Invalid verification response.');
  return payload.result;
}});
async function collectProjectEvidence(env) {
  const pool=createProjectRpcPool({health:projectRpcHealth,maxRequests:240,deadlineAt:Date.now()+42000});
  const registry=canonicalProjectRegistry(ASSETS);
  const result=await runProjectScan(env,{registry,rpc:pool.rpc});
  const runtimeFamilies=await recordRuntimeFamilyAppearances(env,{registry});
  // Diagnostics remain operator-only; never publish private collector state in
  // account responses, the browser bundle, or project-submission receipts.
  return {...result,runtimeFamilies,transport:pool.diagnostics()};
}
async function collectTapeEvidence(env) {
  const pool=createProjectRpcPool({health:tapeRpcHealth,maxRequests:48,deadlineAt:Date.now()+40000});
  const result=await runBaseTapeScan(env,{rpc:pool.rpc});
  return {...result,transport:pool.diagnostics()};
}

export default {
  // Scheduled scanner entry point (10-minute cron). Fails closed when the DB
  // binding is absent so a misconfigured deployment never starts scanning
  // alerts while the rest of the site and RPC keep working.
  async scheduled(_controller, env, ctx) {
    const inspectHook = async (chainId, address) => {
      const result = await hookline_getHook_handler([chainId, address], 1, ctx);
      if (result?.type) throw new Error(result.message || 'hook inspection failed');
      return result;
    };
    const projects = async () => {
      const result=await collectProjectEvidence(env);
      if(env.TELEGRAM_BOT_TOKEN) {
        const send=(chatId,text,options)=>new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId,text,options);
        await deliverProjectEvents(env,{send});
        await deliverRuntimeFamilyAppearances(env,{send});
      }
      return result;
    };
    const scan = Promise.allSettled([runAlertScan(env, { resolveHookMarkets, inspectHook,
      resolveFirstPartyPools:(chainId,address)=>liveTapePoolsForHook(env,chainId,address),
      resolveFirstPartySwapFees:(chainId,address)=>liveTapeSwapFeesForHook(env,chainId,address),
      resolveFirstPartyActivity:(chainId,address,cursor)=>liveTapeActivityForHook(env,chainId,address,{cursor}) }), projects(), collectTapeEvidence(env), pruneAccountEphemera(env)]);
    ctx.waitUntil(scan);
    return scan;
  },

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

    // Authentication and personal data never share public CORS or edge caches.
    if (url.pathname.startsWith('/api/account/')) {
      const response=await handleAccountsApi(request,env,{verifySmartWalletSignature});
      if(response) return response;
    }

    if (url.pathname==='/api/tape-maintenance/scan') {
      const configured=typeof env.PROJECT_REVIEW_TOKEN==='string' && env.PROJECT_REVIEW_TOKEN.length>=32;
      const candidate=(request.headers.get('authorization') || '').replace(/^Bearer /,'');
      if(method!=='POST') return Response.json({error:'method_not_allowed'},{status:405,headers:{'Cache-Control':'no-store'}});
      if(!configured || !candidate || await projectDigest(candidate)!==await projectDigest(env.PROJECT_REVIEW_TOKEN)) return Response.json({error:'operator_access_required'},{status:403,headers:{'Cache-Control':'no-store'}});
      try {return Response.json(await collectTapeEvidence(env),{headers:{'Cache-Control':'private, no-store'}});}
      catch {return Response.json({error:'tape_scan_failed'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
    }
    if (url.pathname.startsWith('/api/tape/')) {
      const tapeResponse=await handleTapeApi(request,env);
      if(tapeResponse) return tapeResponse;
    }

    if (url.pathname.startsWith('/api/project')) {
      if(url.pathname==='/api/project-maintenance/bot-status') {
        const configured=typeof env.PROJECT_REVIEW_TOKEN==='string' && env.PROJECT_REVIEW_TOKEN.length>=32;
        const candidate=(request.headers.get('authorization') || '').replace(/^Bearer /,'');
        if(method!=='GET') return Response.json({error:'method_not_allowed'},{status:405,headers:{'Cache-Control':'no-store'}});
        if(!configured || !candidate || await projectDigest(candidate)!==await projectDigest(env.PROJECT_REVIEW_TOKEN)) return Response.json({error:'operator_access_required'},{status:403,headers:{'Cache-Control':'no-store'}});
        try {
          const client=new TelegramClient(env.TELEGRAM_BOT_TOKEN);
          const [me,info]=await Promise.all([client.getMe(),client.request('/getWebhookInfo')]);
          const registered=info.url?new URL(info.url):null;
          return Response.json({username:me.username,webhookOrigin:registered?.origin || null,
            canonicalWebhook:registered?.href==='https://hookline.world/telegram/webhook',
            webhookPath:registered && ['/tg/webhook','/telegram/webhook'].includes(registered.pathname)?registered.pathname:'other',
            pendingUpdates:info.pending_update_count || 0,lastErrorAt:info.last_error_date || null},
            {headers:{'Cache-Control':'private, no-store'}});
        } catch {return Response.json({error:'bot_status_unavailable'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
      }
      if(url.pathname==='/api/project-maintenance/scan') {
        const configured=typeof env.PROJECT_REVIEW_TOKEN==='string' && env.PROJECT_REVIEW_TOKEN.length>=32;
        const candidate=(request.headers.get('authorization') || '').replace(/^Bearer /,'');
        if(method!=='POST') return Response.json({error:'method_not_allowed'},{status:405,headers:{'Cache-Control':'no-store'}});
        if(!configured || !candidate || await projectDigest(candidate)!==await projectDigest(env.PROJECT_REVIEW_TOKEN)) return Response.json({error:'operator_access_required'},{status:403,headers:{'Cache-Control':'no-store'}});
        try {return Response.json(await collectProjectEvidence(env),{headers:{'Cache-Control':'private, no-store'}});}
        catch {return Response.json({error:'project_scan_failed'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
      }
      // Private receipts and moderation never enter an edge cache. Shared GET
      // snapshots amortize database reads across visitors, not across identities.
      const cacheable=method==='GET' && !request.headers.has('authorization') &&
        (url.pathname==='/api/projects' || /^\/api\/projects\/[a-z0-9-]{1,60}$/.test(url.pathname) || url.pathname==='/api/project-activity');
      let projectKey=null;
      if(cacheable) {
        // Static project metadata ships inside the Worker. Key shared snapshots
        // by the same content hash as the browser bundle so a new deployment
        // cannot inherit an older registry/profile response from Cache API.
        const cacheUrl=new URL(`https://hookline.world/__project-cache/${ASSETS.version}${url.pathname}`);
        if(url.pathname==='/api/project-activity') {
          const project=url.searchParams.get('project');
          if(project) cacheUrl.searchParams.set('project',project);
          cacheUrl.searchParams.set('focus',url.searchParams.get('focus') || 'important');
          cacheUrl.searchParams.set('history',url.searchParams.get('history') || 'all');
          cacheUrl.searchParams.set('signal',url.searchParams.get('signal') || 'all');
        }
        projectKey=new Request(cacheUrl.toString());
      }
      if(projectKey && globalThis.caches?.default) {
        const cached=await caches.default.match(projectKey);
        if(cached) return cached;
      }
      const projectResponse=await handleProjectsApi(request,env,ASSETS);
      if(projectResponse) {
        if(projectKey && projectResponse.ok && globalThis.caches?.default) ctx.waitUntil(caches.default.put(projectKey,projectResponse.clone()));
        return projectResponse;
      }
    }

    // Static assets.
    const staticResponse = handleStaticAsset(url.pathname);
    if (staticResponse) {
      return staticResponse;
    }

    // GET /api/v3/hook-markets — pool identities from v4.xyz enriched with
    // current DexScreener market data and chart destinations.
    // Keep the original path as a compatible alias. The versioned path also
    // gives deployed resolver fixes a fresh outer-CDN key.
    if (method === 'GET' && ['/api/hook-markets', '/api/v2/hook-markets', '/api/v3/hook-markets'].includes(url.pathname)) {
      const chainId = Number(url.searchParams.get('chainId'));
      const address = String(url.searchParams.get('address') || '').trim();
      if (!Number.isSafeInteger(chainId) || chainId <= 0 || !EVM_ADDRESS_RE.test(address)) {
        return new Response(JSON.stringify({ error: 'valid chainId and hook address required' }), {
          status: 400,
          headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
        });
      }

      const canonicalAddress = canonicalIndexedHookAddress(chainId, address);
      const cacheUrl = new URL('/api/v3/hook-markets', url.origin);
      cacheUrl.searchParams.set('feeFormat','2');
      cacheUrl.searchParams.set('chainId', String(chainId));
      cacheUrl.searchParams.set('address', address.toLowerCase());
      cacheUrl.searchParams.set('schema', MARKET_CACHE_SCHEMA_VERSION);
      const cacheRequest = new Request(cacheUrl.toString(), { method: 'GET' });
      const edgeCache = globalThis.caches?.default;

      if (edgeCache) {
        const cachedResponse = await edgeCache.match(cacheRequest);
        if (cachedResponse) {
          const headers = new Headers(cachedResponse.headers);
          headers.set('X-Hookline-Cache', 'HIT');
          return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers,
          });
        }
      }

      try {
        const response = new Response(JSON.stringify(await resolveHookMarkets(chainId, canonicalAddress)), {
          headers: baseJsonHeaders({
            'Cache-Control': `public, max-age=120, s-maxage=${MARKET_EDGE_CACHE_SECONDS}, stale-while-revalidate=86400`,
            'Access-Control-Expose-Headers': 'X-Hookline-Cache',
            'X-Hookline-Cache': 'MISS',
          }),
        });
        if (edgeCache) {
          const cacheWrite = edgeCache.put(cacheRequest, response.clone());
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cacheWrite);
          else await cacheWrite;
        }
        return response;
      } catch {
        return new Response(JSON.stringify({ error: 'market data unavailable', markets: [] }), {
          status: 502,
          headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
        });
      }
    }

    // GET /api/token-hooks — reverse the graph from a token or top pool into
    // its visible hook, then let the hook profile expose the sibling markets.
    if (method === 'GET' && url.pathname === '/api/token-hooks') {
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      if (query.length === 1) {
        return new Response(JSON.stringify({ error: 'token query must be empty or at least 2 characters' }), {
          status: 400,
          headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
        });
      }

      const cacheUrl = new URL('/api/token-hooks', url.origin);
      if (query) cacheUrl.searchParams.set('q', query.toLowerCase());
      else cacheUrl.searchParams.set('index', String(staticTokenIndex().generatedAt || '1'));
      const cacheRequest = new Request(cacheUrl.toString(), { method: 'GET' });
      const edgeCache = globalThis.caches?.default;
      if (edgeCache) {
        const cachedResponse = await edgeCache.match(cacheRequest);
        if (cachedResponse) {
          const headers = new Headers(cachedResponse.headers);
          headers.set('X-Hookline-Cache', 'HIT');
          return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers,
          });
        }
      }

      try {
        const response = new Response(JSON.stringify(await resolveTokenHooks(query)), {
          headers: baseJsonHeaders({
            'Cache-Control': `public, max-age=120, s-maxage=${MARKET_EDGE_CACHE_SECONDS}, stale-while-revalidate=86400`,
            'Access-Control-Expose-Headers': 'X-Hookline-Cache',
            'X-Hookline-Cache': 'MISS',
          }),
        });
        if (edgeCache) {
          const cacheWrite = edgeCache.put(cacheRequest, response.clone());
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cacheWrite);
          else await cacheWrite;
        }
        return response;
      } catch {
        return new Response(JSON.stringify({ error: 'token relationship data unavailable', relationships: [] }), {
          status: 502,
          headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
        });
      }
    }

    // Private RavenOS service binding supplies validated unsigned EVM routes.
    // Hookline never receives API keys or wallet secrets, and this Worker never
    // signs or submits transactions.
    if (method === 'GET' && url.pathname === '/api/execution/status') {
      if (!env?.RAVENOS_EXECUTION?.capability) {
        return executionJson({ ok: false, state: 'unavailable', chains: [] }, 503);
      }
      const requestedChainId = url.searchParams.get('chainId');
      const chainIds = requestedChainId === null ? EXECUTION_CHAIN_IDS : [Number(requestedChainId)];
      if (chainIds.some((chainId) => !EXECUTION_CHAIN_SET.has(chainId))) {
        return executionJson({ ok: false, error: 'chain_not_supported' }, 400);
      }
      const settled = await Promise.allSettled(chainIds.map((chainId) => env.RAVENOS_EXECUTION.capability(chainId)));
      const chains = settled.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { chain_id: chainIds[index], state: 'unavailable', quote_review_enabled: false });
      return executionJson({
        ok: chains.some((chain) => chain.quote_review_enabled === true),
        state: chains.some((chain) => chain.quote_review_enabled === true) ? 'available' : 'unavailable',
        chains,
        signing_location: 'user_wallet',
        custody: false,
      });
    }

    if (method === 'GET' && url.pathname === '/api/execution/token') {
      if (!env?.RAVENOS_EXECUTION?.tokenMetadata) {
        return executionJson({ ok: false, error: 'token_service_unavailable' }, 503);
      }
      const chainId = Number(url.searchParams.get('chainId'));
      const address = String(url.searchParams.get('address') || '').toLowerCase();
      const wallet = String(url.searchParams.get('wallet') || '').toLowerCase();
      if (!EXECUTION_CHAIN_SET.has(chainId)) return executionJson({ ok: false, error: 'chain_not_supported' }, 400);
      if (!EVM_ADDRESS_RE.test(address) || /^0x0{40}$/.test(address)) return executionJson({ ok: false, error: 'token_invalid' }, 400);
      if (wallet && (!EVM_ADDRESS_RE.test(wallet) || /^0x0{40}$/.test(wallet))) return executionJson({ ok: false, error: 'wallet_invalid' }, 400);
      try {
        const token = wallet
          ? await env.RAVENOS_EXECUTION.tokenMetadata(chainId, address, wallet)
          : await readExecutionTokenMetadata(chainId, address, env);
        return executionJson({ ok: true, token });
      } catch (error) {
        const code = String(error?.code || error?.message || 'token_service_unavailable').replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 100);
        return executionJson({ ok: false, error: code }, 503);
      }
    }

    if (method === 'POST' && url.pathname === '/api/execution/quote') {
      const rl = checkRateLimit(`execution:${getConnectingIp(request)}`);
      if (rl.tooMany) {
        return executionJson({ ok: false, error: 'rate_limited', retry_after: rl.retryAfter }, 429);
      }
      if (!env?.RAVENOS_EXECUTION?.quote) {
        return executionJson({ ok: false, error: 'quote_service_unavailable' }, 503);
      }
      try {
        const order = await readExecutionOrder(request);
        const quote = await env.RAVENOS_EXECUTION.quote(order);
        const publicQuote = publicExecutionQuote(quote);
        const intent = await createExecutionIntent(order, publicQuote, env.DB);
        return executionJson({ ok: true, quote: { ...publicQuote, execution_intent: intent } });
      } catch (error) {
        const status = Number(error?.status);
        const safeStatus = Number.isSafeInteger(status) && status >= 400 && status <= 499 ? status : 503;
        const code = String(error?.code || error?.message || 'quote_service_unavailable').replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 100);
        return executionJson({ ok: false, error: code }, safeStatus);
      }
    }

    if (method === 'POST' && url.pathname === '/api/execution/receipt') {
      const rl = checkRateLimit(`receipt:${getConnectingIp(request)}`);
      if (rl.tooMany) {
        return executionJson({ ok: false, error: 'rate_limited', retry_after: rl.retryAfter }, 429);
      }
      try {
        const input = await readExecutionReceiptRequest(request);
        const receipt = await reconcileExecutionReceipt(input, env);
        return executionJson({ ok: true, receipt });
      } catch (error) {
        const status = Number(error?.status);
        const safeStatus = Number.isSafeInteger(status) && status >= 400 && status <= 499 ? status : 503;
        const code = String(error?.code || error?.message || 'execution_receipt_unavailable').replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 100);
        return executionJson({ ok: false, error: code }, safeStatus);
      }
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
      const payTo = typeof env?.X402_PAY_TO === 'string' ? env.X402_PAY_TO.trim() : '';
      if (!EVM_ADDRESS_RE.test(payTo)) {
        return new Response(
          JSON.stringify({ error: 'paid capacity is temporarily unavailable' }),
          { status: 503, headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }) }
        );
      }
      const paidResponse = await getPaidRpcApp(payTo).fetch(request, env, ctx);
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


    // POST /telegram/webhook: Telegram Bot API webhook for Hookline messages and
    // callback queries. Secret-verified with the X-Telegram-Bot-Api-Secret-Token
    // header, then delegated to the bot module (bot/index.js). All public
    // website and JSON-RPC routes above are untouched.
    if (method === 'POST' && (url.pathname === '/telegram/webhook' || url.pathname === '/tg/webhook')) {
      const verify = verifyWebhookSecret(request, env?.TELEGRAM_WEBHOOK_SECRET);
      if (!verify.ok) {
        return new Response(
          JSON.stringify({ error: 'webhook secret invalid', reason: verify.reason }),
          { status: 401, headers: baseJsonHeaders() }
        );
      }
      let update;
      try {
        update = JSON.parse(await request.text());
      } catch {
        return new Response(
          JSON.stringify({ error: 'invalid update payload' }),
          { status: 400, headers: baseJsonHeaders() }
        );
      }
      const result = await handleTelegramUpdate(update, env, {
        resolveTokenHooks,
        resolveHookMarkets,
        resolveAlertIdentity:resolveIndexedAlertIdentity,
        projects:projectContext(ASSETS,env),
        accounts:{consumeTelegramLink:identity=>consumeTelegramLink(env,identity)},
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
      });
    }

    return sendNotFound();
  },
};
