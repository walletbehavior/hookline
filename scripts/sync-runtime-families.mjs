#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const hooksPath = resolve(root, 'dist/hooks.json');
const outputPath = resolve(root, 'dist/runtime-families.json');
const batchSize = 20;
const retryFailuresOnly = process.argv.includes('--retry-failures');

const chainEndpoints = Object.freeze({
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  56: ['https://bsc-dataseed.bnbchain.org'],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  42161: ['https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc'],
  4663: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'],
});

function chunks(rows, size) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function fetchRpc(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchBatch(endpoints, rows) {
  const payload = rows.map((row, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'eth_getCode',
    params: [row.address, 'latest'],
  }));
  let lastError;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchRpc(endpoint, payload);
        if (!Array.isArray(response)) throw new Error('batch response was not an array');
        const byId = new Map(response.map((entry) => [Number(entry?.id), entry]));
        return rows.map((row, index) => {
          const entry = byId.get(index + 1);
          const code = typeof entry?.result === 'string' && /^0x[0-9a-fA-F]*$/.test(entry.result)
            ? entry.result.toLowerCase()
            : null;
          return { row, code, error: code == null ? String(entry?.error?.message || 'code unavailable') : null };
        });
      } catch (error) {
        lastError = error;
        await sleep(200 * (attempt + 1));
      }
    }
  }
  return rows.map((row) => ({ row, code: null, error: lastError?.message || 'RPC unavailable' }));
}

async function fetchBlock(endpoints) {
  for (const endpoint of endpoints) {
    try {
      const result = await fetchRpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
      if (typeof result?.result === 'string') return Number.parseInt(result.result, 16);
    } catch {
      // Try the next configured endpoint.
    }
  }
  return null;
}

function fingerprint(code) {
  if (!code || code === '0x') return null;
  return createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
}

function deploymentFromResult(chainId, result) {
  const hash = fingerprint(result.code);
  return {
    id: result.row.id,
    chainId,
    address: result.row.address.toLowerCase(),
    name: result.row.project?.name || result.row.verifiedContract?.name || result.row.name || null,
    fingerprint: hash,
    codeByteLength: hash ? (result.code.length - 2) / 2 : 0,
    status: hash ? 'observed' : result.code === '0x' ? 'no-code' : 'error',
    error: hash ? null : result.error,
  };
}

async function scanChain(chainId, hooks) {
  const endpoints = chainEndpoints[chainId];
  const blockNumber = await fetchBlock(endpoints);
  const deployments = [];
  for (const group of chunks(hooks, batchSize)) {
    const results = await fetchBatch(endpoints, group);
    for (const result of results) deployments.push(deploymentFromResult(chainId, result));
    await sleep(80);
  }
  const retryRows = deployments.filter((row) => row.status === 'error');
  if (retryRows.length) {
    await sleep(2_000);
    const byId = new Map(deployments.map((row, index) => [row.id, index]));
    for (const group of chunks(retryRows, 5)) {
      const results = await fetchBatch(endpoints, group);
      for (const result of results) deployments[byId.get(result.row.id)] = deploymentFromResult(chainId, result);
      await sleep(200);
    }
  }
  return { chainId, blockNumber, deployments };
}

const snapshot = JSON.parse(await readFile(hooksPath, 'utf8'));
const hooks = Array.isArray(snapshot.hooks) ? snapshot.hooks : [];
const supportedHooks = hooks.filter((hook) => chainEndpoints[Number(hook.chainId)]);
let previousSnapshot = null;
try {
  previousSnapshot = JSON.parse(await readFile(outputPath, 'utf8'));
} catch {
  // The first scan has no retained observations.
}
const previousById = new Map((previousSnapshot?.deployments || []).map((row) => [row.id, row]));
const hooksToScan = retryFailuresOnly
  ? supportedHooks.filter((hook) => previousById.get(hook.id)?.status !== 'observed')
  : supportedHooks;
const chainResults = await Promise.all(Object.keys(chainEndpoints).map((value) => {
  const chainId = Number(value);
  return scanChain(chainId, hooksToScan.filter((hook) => Number(hook.chainId) === chainId));
}));

const scannedById = new Map(chainResults.flatMap((result) => result.deployments).map((row) => [row.id, row]));
let retainedPriorObservations = 0;
const deployments = supportedHooks.map((hook) => {
  const scanned = scannedById.get(hook.id);
  const previous = previousById.get(hook.id);
  if ((!scanned || scanned.status === 'error') && previous?.status === 'observed') {
    retainedPriorObservations += 1;
    return previous;
  }
  return scanned || previous || {
    id: hook.id,
    chainId: hook.chainId,
    address: hook.address.toLowerCase(),
    name: hook.project?.name || hook.verifiedContract?.name || null,
    fingerprint: null,
    codeByteLength: 0,
    status: 'error',
    error: 'not scanned',
  };
});
const familyMap = new Map();
for (const deployment of deployments) {
  if (!deployment.fingerprint) continue;
  const family = familyMap.get(deployment.fingerprint) || [];
  family.push(deployment);
  familyMap.set(deployment.fingerprint, family);
}

const families = [...familyMap.entries()].map(([runtimeFingerprint, members]) => ({
  runtimeFingerprint,
  codeByteLength: members[0].codeByteLength,
  deploymentCount: members.length,
  chainIds: [...new Set(members.map((member) => member.chainId))].sort((left, right) => left - right),
  representativeName: members.find((member) => member.name)?.name || null,
  deployments: members.map((member) => member.id).sort(),
})).sort((left, right) => right.deploymentCount - left.deploymentCount || left.runtimeFingerprint.localeCompare(right.runtimeFingerprint));

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'Hookline direct eth_getCode observations',
  coverage: {
    hooksIndexed: hooks.length,
    hooksEligible: supportedHooks.length,
    deploymentsObserved: deployments.filter((row) => row.status === 'observed').length,
    deploymentsWithoutCode: deployments.filter((row) => row.status === 'no-code').length,
    deploymentsFailed: deployments.filter((row) => row.status === 'error').length,
    retainedPriorObservations,
    runtimeFamilies: families.length,
    repeatedFamilies: families.filter((family) => family.deploymentCount > 1).length,
  },
  observations: Object.fromEntries(chainResults.map((result) => [String(result.chainId), { blockNumber: result.blockNumber }])),
  deployments,
  families,
};

await writeFile(outputPath, `${JSON.stringify(output)}\n`);
console.log(`Wrote ${outputPath}`);
console.log(JSON.stringify(output.coverage, null, 2));
