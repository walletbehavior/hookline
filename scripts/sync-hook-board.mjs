import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SEARCH_URL = 'https://www.v4.xyz/api/search?q=';
const INFO_URL = 'https://www.v4.xyz/api/hooks/info';
const OUTPUT = resolve('dist/hooks.json');
const VERIFIED_IDENTITIES = resolve('data/verified-hook-identities.json');
const HEX = '0123456789abcdef';
const RESULT_CAP = 5;
// The public endpoint caps each search at five hooks. Two address nibbles
// creates a broad, bounded activity-leader set across 256 buckets without
// hammering a community service or pretending the result is exhaustive.
const MAX_PREFIX_LENGTH = 2;
const CONCURRENCY = 6;
const MAX_RETRIES = 5;

function verifiedIdentityMap() {
  if (!existsSync(VERIFIED_IDENTITIES)) return new Map();
  try {
    const snapshot = JSON.parse(readFileSync(VERIFIED_IDENTITIES, 'utf8'));
    const identities = snapshot && typeof snapshot.identities === 'object' ? snapshot.identities : {};
    return new Map(Object.entries(identities));
  } catch {
    return new Map();
  }
}

const CHAIN_NAMES = Object.freeze({
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  130: 'Unichain',
  137: 'Polygon',
  143: 'Monad',
  146: 'Sonic',
  480: 'World Chain',
  1868: 'Soneium',
  4663: 'Robinhood Chain',
  8453: 'Base',
  42161: 'Arbitrum One',
  42220: 'Celo',
  43114: 'Avalanche',
  57073: 'Ink',
  81457: 'Blast',
});

const SUPPORTED_LIVE_CHAINS = new Set([1, 56, 8453, 42161, 4663]);

const HOOKLINE_RESEARCHED_PROJECTS = Object.freeze([
  {
    sourceId: 'hookline-claus',
    hookId: '1_0x37bfb8ac7c960e558657871d41ca70e07e7dbfff',
    name: 'CLAUS',
    description: 'An upgradeable Uniswap v4 fee hook that routes swap fees across a project allocation, CLAUS NFT holders, buyback and burn, liquidity, FOMO buybacks, and a platform allocation.',
    type: 'Dynamic fee, fee routing',
    dex: 'Uniswap v4',
    stage: 'Mainnet',
    website: 'https://ikaxbt.com/claus',
    x: null,
    provenance: 'Hookline researched',
  },
  {
    sourceId: 'hookline-engram',
    hookId: '1_0x0ee851f1fe2f4bdba79fee78969e329c136ca0cc',
    name: 'ENGRAM',
    description: 'A Uniswap v4 launchpad where each token receives a hook-managed onchain model that adjusts LP fees from its own market activity, with public training rounds and creator fee sharing.',
    type: 'Dynamic fee, launchpad, onchain model',
    dex: 'Uniswap v4',
    stage: 'Mainnet',
    website: 'https://engramv4.xyz/',
    x: 'https://x.com/engram_v4',
    provenance: 'Hookline researched',
  },
]);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchJson(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Hookline index snapshot (https://hookline.world)',
      },
    });
    if (response.ok) return response.json();
    if (attempt === MAX_RETRIES || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    await sleep(500 * (2 ** attempt));
  }
  throw new Error(`failed to fetch ${url}`);
}

function validHook(raw) {
  const id = typeof raw?.id === 'string' ? raw.id : '';
  const match = id.match(/^([0-9]+)_(0x[0-9a-fA-F]{40})$/);
  if (!match) return null;
  const chainId = Number(match[1]);
  const address = match[2];
  if (!Number.isSafeInteger(chainId)) return null;
  return {
    id: `${chainId}_${address.toLowerCase()}`,
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    address,
    numberOfPools: Math.max(0, Number.parseInt(raw.numberOfPools, 10) || 0),
    numberOfSwaps: Math.max(0, Number.parseInt(raw.numberOfSwaps, 10) || 0),
    liveInspection: SUPPORTED_LIVE_CHAINS.has(chainId),
  };
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function projectRecords(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((record) => {
    const fields = record && typeof record.fields === 'object' ? record.fields : {};
    const address = typeof fields.address === 'string'
      ? fields.address
      : typeof fields.Address === 'string' ? fields.Address : '';
    const match = address.match(/^([0-9]+)_(0x[0-9a-fA-F]{40})$/);
    return {
      sourceId: typeof record?.id === 'string' ? record.id : null,
      hookId: match ? `${Number(match[1])}_${match[2].toLowerCase()}` : null,
      name: typeof fields.Name === 'string' ? fields.Name.trim().slice(0, 120) : '',
      description: typeof fields['Project Description'] === 'string'
        ? fields['Project Description'].trim().slice(0, 800)
        : '',
      type: typeof fields.Type === 'string' ? fields.Type.trim().slice(0, 200) : '',
      dex: typeof fields.Dex === 'string' ? fields.Dex.trim().slice(0, 120) : '',
      stage: typeof fields['Stage '] === 'string'
        ? fields['Stage '].trim().slice(0, 120)
        : typeof fields.Stage === 'string' ? fields.Stage.trim().slice(0, 120) : '',
      website: cleanUrl(fields.website),
      x: cleanUrl(fields.X),
      provenance: 'community record',
    };
  }).filter((project) => project.name);
}

const queue = HEX.split('');
const hooks = new Map();
let completed = 0;

async function crawlPrefix(prefix) {
  const payload = await fetchJson(SEARCH_URL + encodeURIComponent(`0x${prefix}`));
  const found = Array.isArray(payload?.hooks) ? payload.hooks : [];
  for (const raw of found) {
    const hook = validHook(raw);
    if (hook) hooks.set(hook.id, hook);
  }
  if (found.length >= RESULT_CAP && prefix.length < MAX_PREFIX_LENGTH) {
    for (const nibble of HEX) queue.push(prefix + nibble);
  }
  completed += 1;
  if (completed % 50 === 0) {
    console.log(`crawled ${completed} prefixes; queued ${queue.length}; found ${hooks.size} hooks`);
  }
}

async function worker() {
  while (queue.length) {
    const prefix = queue.shift();
    await crawlPrefix(prefix);
  }
}

console.log('Syncing the public Uniswap v4 hook discovery snapshot…');
const [info] = await Promise.all([
  fetchJson(INFO_URL),
  Promise.all(Array.from({ length: CONCURRENCY }, () => worker())),
]);

const communityProjects = projectRecords(info);
const verifiedIdentities = verifiedIdentityMap();
const projectKeys = new Set(HOOKLINE_RESEARCHED_PROJECTS.map((project) => project.hookId || project.name.toLowerCase()));
const projects = HOOKLINE_RESEARCHED_PROJECTS.concat(
  communityProjects.filter((project) => !projectKeys.has(project.hookId || project.name.toLowerCase()))
);
const projectsByHook = new Map(projects.filter((project) => project.hookId).map((project) => [project.hookId, project]));
for (const project of HOOKLINE_RESEARCHED_PROJECTS) {
  if (!project.hookId || hooks.has(project.hookId)) continue;
  const match = project.hookId.match(/^([0-9]+)_(0x[0-9a-f]{40})$/);
  if (!match) continue;
  const chainId = Number(match[1]);
  hooks.set(project.hookId, {
    id: project.hookId,
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    address: match[2],
    numberOfPools: 0,
    numberOfSwaps: 0,
    liveInspection: SUPPORTED_LIVE_CHAINS.has(chainId),
  });
}
const sortedHooks = [...hooks.values()]
  .map((hook) => ({
    ...hook,
    project: projectsByHook.get(hook.id) || null,
    verifiedContract: verifiedIdentities.get(hook.id) || null,
  }))
  .sort((a, b) => b.numberOfSwaps - a.numberOfSwaps || b.numberOfPools - a.numberOfPools || a.id.localeCompare(b.id));
const chains = [...new Set(sortedHooks.map((hook) => hook.chainId))]
  .map((chainId) => ({
    chainId,
    name: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    hookCount: sortedHooks.filter((hook) => hook.chainId === chainId).length,
    liveInspection: SUPPORTED_LIVE_CHAINS.has(chainId),
  }))
  .sort((a, b) => b.hookCount - a.hookCount || a.chainId - b.chainId);

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  coverage: {
    hookCount: sortedHooks.length,
    projectRecordCount: projects.length,
    chainCount: chains.length,
    totalPools: sortedHooks.reduce((sum, hook) => sum + hook.numberOfPools, 0),
    totalSwaps: sortedHooks.reduce((sum, hook) => sum + hook.numberOfSwaps, 0),
    searchPrefixes: completed,
    searchPrefixDepth: MAX_PREFIX_LENGTH,
    discoveryMethod: 'top activity results for every two-nibble address prefix',
    exhaustive: false,
    verifiedIdentityCount: sortedHooks.filter((hook) => hook.verifiedContract?.name).length,
  },
  sources: [
    {
      label: 'v4.xyz community indexer',
      role: 'hook discovery and aggregate pool/swap counts',
      url: 'https://www.v4.xyz/',
    },
    {
      label: 'v4.xyz hook directory',
      role: 'project-submitted or community-curated names and descriptions',
      url: INFO_URL,
    },
    {
      label: 'Sourcify verified contract dataset',
      role: 'verified deployed contract titles',
      url: 'https://export.sourcify.dev/v2/',
    },
  ],
  chains,
  projects,
  hooks: sortedHooks,
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(snapshot)}\n`, 'utf8');
console.log(`wrote ${OUTPUT}`);
console.log(`${snapshot.coverage.hookCount} hooks across ${snapshot.coverage.chainCount} chains`);
console.log(`${snapshot.coverage.totalPools.toLocaleString()} pools · ${snapshot.coverage.totalSwaps.toLocaleString()} swaps`);
