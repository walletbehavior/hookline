import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const identityPath = resolve('data/verified-hook-identities.json');
const hookPath = resolve('dist/hooks.json');
const tokenPaths = [resolve('data/token-hook-index.json'), resolve('dist/token-hooks.json')];

const researchedProjects = Object.freeze([
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

const researchedRelationships = Object.freeze([
  {
    poolId: '1_0xc3bcbfb2b362b046448a1c0fddfd7b12aab9d877bacb6ba26172e552af8e8c73',
    poolName: 'ETH / ENGRAM',
    pairLabel: 'ENGRAM / ETH',
    chainId: 1,
    chainName: 'Ethereum',
    hookId: '1_0x0ee851f1fe2f4bdba79fee78969e329c136ca0cc',
    hookAddress: '0x0Ee851f1fe2f4BDbA79FeE78969E329C136CA0cc',
    hookName: 'ENGRAM',
    hookNamed: true,
    baseToken: {
      address: '0x56C915D92E24255fdC52eb114a31399c432B7Cc6',
      name: 'Engram',
      symbol: 'ENGRAM',
    },
    quoteToken: {
      address: '0x0000000000000000000000000000000000000000',
      name: 'Ether',
      symbol: 'ETH',
    },
    transactions: null,
    liquidityUsd: null,
    volumeUsd: null,
    chartUrl: 'https://dexscreener.com/ethereum/0xc3bcbfb2b362b046448a1c0fddfd7b12aab9d877bacb6ba26172e552af8e8c73',
  },
]);

if (!existsSync(identityPath)) throw new Error(`missing ${identityPath}`);
if (!existsSync(hookPath)) throw new Error(`missing ${hookPath}`);

const identitySnapshot = JSON.parse(readFileSync(identityPath, 'utf8'));
const hookSnapshot = JSON.parse(readFileSync(hookPath, 'utf8'));
const identities = identitySnapshot && typeof identitySnapshot.identities === 'object'
  ? identitySnapshot.identities
  : {};

hookSnapshot.projects = Array.isArray(hookSnapshot.projects) ? hookSnapshot.projects : [];
for (const project of researchedProjects) {
  const priorIndex = hookSnapshot.projects.findIndex((candidate) => candidate?.sourceId === project.sourceId);
  if (priorIndex >= 0) hookSnapshot.projects[priorIndex] = project;
  else hookSnapshot.projects.unshift(project);
  const hook = hookSnapshot.hooks.find((candidate) => candidate?.id === project.hookId);
  if (hook) hook.project = project;
  else {
    const [, chainId, address] = project.hookId.match(/^([0-9]+)_(0x[0-9a-f]{40})$/) || [];
    if (chainId && address) hookSnapshot.hooks.push({
      id: project.hookId,
      chainId: Number(chainId),
      chainName: Number(chainId) === 1 ? 'Ethereum' : `Chain ${chainId}`,
      address,
      numberOfPools: 1,
      numberOfSwaps: 0,
      liveInspection: [1, 8453, 42161, 4663].includes(Number(chainId)),
      project,
      verifiedContract: null,
    });
  }
}

let matched = 0;
hookSnapshot.hooks = hookSnapshot.hooks.map((hook) => {
  const verifiedContract = identities[hook.id] || null;
  if (verifiedContract?.name) matched += 1;
  return { ...hook, verifiedContract };
});
hookSnapshot.coverage = {
  ...hookSnapshot.coverage,
  hookCount: hookSnapshot.hooks.length,
  projectRecordCount: hookSnapshot.projects.length,
  verifiedIdentityCount: matched,
};
hookSnapshot.sources = Array.isArray(hookSnapshot.sources) ? hookSnapshot.sources : [];
if (!hookSnapshot.sources.some((source) => source?.label === 'Sourcify verified contract dataset')) {
  hookSnapshot.sources.push({
    label: 'Sourcify verified contract dataset',
    role: 'verified deployed contract titles',
    url: 'https://export.sourcify.dev/v2/',
  });
}

writeFileSync(hookPath, `${JSON.stringify(hookSnapshot)}\n`, 'utf8');
console.log(`applied ${matched} verified contract identities to ${hookPath}`);

const hookNames = new Map(hookSnapshot.hooks.map((hook) => [
  hook.id,
  hook.project?.name || hook.verifiedContract?.name || '',
]));
for (const tokenPath of tokenPaths) {
  if (!existsSync(tokenPath)) continue;
  const tokenSnapshot = JSON.parse(readFileSync(tokenPath, 'utf8'));
  if (!Array.isArray(tokenSnapshot.relationships)) continue;
  for (const relationship of researchedRelationships) {
    const priorIndex = tokenSnapshot.relationships.findIndex((candidate) => candidate?.poolId === relationship.poolId);
    if (priorIndex >= 0) tokenSnapshot.relationships[priorIndex] = {
      ...tokenSnapshot.relationships[priorIndex],
      ...relationship,
    };
    else tokenSnapshot.relationships.unshift(relationship);
  }
  tokenSnapshot.coverage = {
    ...tokenSnapshot.coverage,
    relationships: tokenSnapshot.relationships.length,
  };
  let renamed = 0;
  tokenSnapshot.relationships = tokenSnapshot.relationships.map((relationship) => {
    const hookId = `${Number(relationship.chainId)}_${String(relationship.hookAddress || '').toLowerCase()}`;
    const hookName = hookNames.get(hookId);
    if (!hookName || hookName === relationship.hookName) return relationship;
    renamed += 1;
    return { ...relationship, hookName, hookNamed: true };
  });
  writeFileSync(tokenPath, `${JSON.stringify(tokenSnapshot)}\n`, 'utf8');
  console.log(`applied ${renamed} verified hook names to ${tokenPath}`);
}
