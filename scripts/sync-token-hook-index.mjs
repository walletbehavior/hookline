import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const hooksSnapshot = JSON.parse(readFileSync(resolve(root, 'dist/hooks.json'), 'utf8'));
const hookLimit = Number(process.env.HOOKLINE_TOKEN_HOOK_LIMIT || 400);
const poolsPerHook = Number(process.env.HOOKLINE_TOKEN_POOLS_PER_HOOK || 12);
const concurrency = Number(process.env.HOOKLINE_TOKEN_SYNC_CONCURRENCY || 6);

if (![hookLimit, poolsPerHook, concurrency].every((value) => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('token index limits must be positive integers');
}

const hooks = hooksSnapshot.hooks
  .filter((hook) => hook?.address && Number(hook.numberOfPools) > 0)
  .sort((left, right) => (
    Number(right.numberOfSwaps || 0) - Number(left.numberOfSwaps || 0)
    || Number(right.numberOfPools || 0) - Number(left.numberOfPools || 0)
  ))
  .slice(0, hookLimit);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hookName(hook) {
  return hook.project?.name
    || hook.verifiedContract?.name
    || `Hook ${hook.address.slice(0, 8)}…${hook.address.slice(-6)}`;
}

async function poolsForHook(hook) {
  const url = new URL('https://www.v4.xyz/api/pools-by-hook');
  url.searchParams.set('hookAddress', hook.address);
  url.searchParams.set('chainId', String(hook.chainId));
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const pools = Array.isArray(payload?.Pool) ? payload.Pool : [];
      return pools
        .sort((left, right) => (
          Number(right.totalValueLockedUSD || 0) - Number(left.totalValueLockedUSD || 0)
          || Number(right.txCount || 0) - Number(left.txCount || 0)
        ))
        .slice(0, poolsPerHook)
        .map((pool) => {
          const poolName = String(pool.name || '').slice(0, 140);
          return {
            poolId: String(pool.id || ''),
            poolName,
            pairLabel: poolName.split(' - ')[0].trim() || 'Token pair',
            chainId: Number(hook.chainId),
            chainName: String(hook.chainName || `Chain ${hook.chainId}`),
            hookId: hook.id,
            hookAddress: hook.address,
            hookName: hookName(hook),
            hookNamed: Boolean(hook.project?.name || hook.verifiedContract?.name),
            baseToken: null,
            quoteToken: null,
            transactions: finite(pool.txCount),
            liquidityUsd: finite(pool.totalValueLockedUSD),
            volumeUsd: Math.max(finite(pool.volumeUSD) || 0, finite(pool.untrackedVolumeUSD) || 0) || null,
          };
        })
        .filter((relationship) => /^[0-9]+_0x[0-9a-fA-F]{64}$/.test(relationship.poolId));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

const relationships = [];
const failures = [];
let cursor = 0;
let completed = 0;

async function worker() {
  while (cursor < hooks.length) {
    const index = cursor;
    cursor += 1;
    const hook = hooks[index];
    try {
      relationships.push(...await poolsForHook(hook));
    } catch (error) {
      failures.push({ hookId: hook.id, error: error instanceof Error ? error.message : String(error) });
    }
    completed += 1;
    if (completed % 25 === 0 || completed === hooks.length) {
      console.log(`token index: ${completed}/${hooks.length} hooks, ${relationships.length} relationships, ${failures.length} failures`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, hooks.length) }, () => worker()));

const deduped = [...new Map(relationships.map((relationship) => [relationship.poolId, relationship])).values()]
  .sort((left, right) => (
    (right.liquidityUsd || 0) - (left.liquidityUsd || 0)
    || (right.transactions || 0) - (left.transactions || 0)
  ));

if (deduped.length < 1000) {
  throw new Error(`refusing to replace the token index with only ${deduped.length} relationships`);
}

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'v4.xyz pools-by-hook snapshot',
  coverage: {
    relationships: deduped.length,
    hooksRequested: hooks.length,
    hooksResolved: hooks.length - failures.length,
    hooksFailed: failures.length,
    poolsPerHook,
    exhaustive: false,
  },
  relationships: deduped,
};

for (const target of ['data/token-hook-index.json', 'dist/token-hooks.json']) {
  const output = resolve(root, target);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

console.log(`wrote ${deduped.length} token→hook relationships across ${snapshot.coverage.hooksResolved} hooks`);
