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

'use strict';

// ---------------------------------------------------------------------------
// Static assets (public bundle) — injected by scripts/build-hookline-worker.mjs
// via JSON.stringify over dist/index.html, dist/styles.css, dist/app.js,
// dist/execution-rail.js, dist/hooks.json and dist/token-hooks.json.
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
    upstream: 'https://eth.drpc.org',
  },
  8453: {
    name: 'Base',
    code: 'BASE',
    upstream: 'https://base-rpc.publicnode.com',
    fallbackUpstreams: Object.freeze(['https://mainnet.base.org']),
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
const MARKET_CACHE_SCHEMA_VERSION = '3';
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

function staticTokenIndex() {
  if (!tokenIndexSnapshot) tokenIndexSnapshot = JSON.parse(ASSETS.tokenHooks);
  return tokenIndexSnapshot;
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
  '/data/hooks.json': { type: 'application/json; charset=utf-8', key: 'hooks' },
  '/data/token-hooks.json': { type: 'application/json; charset=utf-8', key: 'tokenHooks' },
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
    "img-src 'self' data:; connect-src 'self' https://api.dexscreener.com; font-src 'self'; frame-ancestors 'none'; form-action 'self'",
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

async function callChainUpstream(config, payload, timeoutMs) {
  const upstreams = [config.upstream, ...(config.fallbackUpstreams || [])];
  let last = null;
  for (const upstream of upstreams) {
    const result = await callUpstream(upstream, payload, timeoutMs);
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
    return {
      poolId: typeof pool.id === 'string' ? pool.id : null,
      poolName: typeof pool.name === 'string' ? pool.name.slice(0, 140) : null,
      pairAddress: addressKey,
      baseToken: tokenShape(pair?.baseToken) || tokenShape(persistent?.baseToken) || { address: null, name: fallbackBase || null, symbol: fallbackBase || null },
      quoteToken: tokenShape(pair?.quoteToken) || tokenShape(persistent?.quoteToken) || { address: null, name: fallbackQuote || null, symbol: fallbackQuote || null },
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
      hookBoard: '/data/hooks.json',
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
  const versionedAsset = path.match(/^\/assets\/[a-f0-9]{12}\/(styles\.css|app\.js|execution-rail\.js)$/);
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

export default {
  // Scheduled scanner entry point (10-minute cron). Fails closed when the DB
  // binding is absent so a misconfigured deployment never starts scanning
  // alerts while the rest of the site and RPC keep working.
  async scheduled(_controller, env, ctx) {
    const scan = runAlertScan(env, { resolveHookMarkets });
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
        return executionJson({ ok: true, quote: publicExecutionQuote(quote) });
      } catch (error) {
        const status = Number(error?.status);
        const safeStatus = Number.isSafeInteger(status) && status >= 400 && status <= 499 ? status : 503;
        const code = String(error?.code || error?.message || 'quote_service_unavailable').replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 100);
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
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: baseJsonHeaders({ 'Cache-Control': 'no-store' }),
      });
    }

    return sendNotFound();
  },
};
