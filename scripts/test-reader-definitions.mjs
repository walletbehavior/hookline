import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAbiItem, toFunctionSelector, toEventSelector, encodeEventTopics, encodeAbiParameters, decodeEventLog } from 'viem';
import { READERS, readerDefinitionsForDeployment } from '../projects/reader-definitions.js';

const seeds = JSON.parse(await readFile(new URL('../data/project-seeds.json', import.meta.url), 'utf8'));
const addressPattern = /^0x[0-9a-f]{40}$/;
const roles = new Set(['hook', 'factory', 'token', 'registry']);
const provenance = new Set(['official deployment reference', 'published project deployment reference', 'community directory relationship']);
const safeHttps = (value) => {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
};

assert.equal(seeds.schemaVersion, 1);
assert(Number.isFinite(Date.parse(seeds.generatedAt)));
assert(seeds.projects.length >= 12, 'The directory must cover the broader ecosystem.');
assert.equal(new Set(seeds.projects.map((p) => p.id)).size, seeds.projects.length);

for (const project of seeds.projects) {
  assert.match(project.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert(project.name.length > 0 && project.name.length <= 80);
  assert(project.summary.length > 0 && project.summary.length < 300);
  assert(project.category.length > 0);
  assert.equal(project.provenance, 'researched project record');
  safeHttps(project.website);
  assert(project.sources.length > 0);
  project.sources.forEach((source) => { assert(source.label); safeHttps(source.url); });
  assert(Array.isArray(project.deployments));
  assert(project.deployments.filter((d) => d.monitor === true).length <= 2, 'Bound scheduled RPC costs per project.');
  const keys = new Set();
  for (const deployment of project.deployments) {
    assert.match(deployment.address, addressPattern, `${project.id}: ${deployment.address}`);
    assert(Number.isSafeInteger(deployment.chainId) && deployment.chainId > 0);
    assert(roles.has(deployment.role));
    assert(provenance.has(deployment.provenance));
    assert.equal(typeof deployment.monitor, 'boolean');
    assert(deployment.name);
    safeHttps(deployment.sourceUrl);
    assert(project.sources.some((source) => source.url === deployment.sourceUrl));
    const key = `${deployment.chainId}:${deployment.address}`;
    assert(!keys.has(key), `Duplicate deployment in ${project.id}: ${key}`);
    keys.add(key);
  }
}

for (const [projectId, reader] of Object.entries(READERS)) {
  const project = seeds.projects.find((p) => p.id === projectId);
  assert(project, `Reader ${projectId} must have a project record.`);
  assert(Number.isInteger(reader.version) && reader.version > 0);
  assert(reader.reads.length <= 6, 'Do not create an unbounded per-observation RPC fan-out.');
  assert(reader.events.length <= 6);
  assert.equal(new Set([...reader.reads, ...reader.events].map((d) => d.key)).size, reader.reads.length + reader.events.length);
  for (const definition of [...reader.reads, ...reader.events]) {
    assert(project.deployments.some((d) => d.chainId === definition.chainId && d.address === definition.address));
    safeHttps(definition.sourceUrl);
    assert(definition.sourceVersion);
    assert(definition.label && definition.description);
  }
  for (const read of reader.reads) {
    assert.match(read.signature, /^[A-Za-z_][A-Za-z0-9_]*\(\)$/);
    assert(['address', 'uint256', 'bool'].includes(read.returns));
    assert(['configuration', 'accrued'].includes(read.classification));
    const abi = parseAbiItem(`function ${read.signature} view returns (${read.returns})`);
    assert.equal(abi.stateMutability, 'view');
    assert.equal(abi.inputs.length, 0);
    assert.match(toFunctionSelector(abi), /^0x[0-9a-f]{8}$/);
  }
  for (const event of reader.events) {
    const abi = parseAbiItem(event.signature);
    assert.equal(abi.type, 'event');
    assert.match(toEventSelector(abi), /^0x[0-9a-f]{64}$/);
    assert(['configured', 'accrued', 'transferred', 'executed'].includes(event.classification));
    if (event.amountField) assert(abi.inputs.some((input) => input.name === event.amountField && input.type === 'uint256'));
    if (event.recipientField) assert(abi.inputs.some((input) => input.name === event.recipientField && input.type === 'address'));
  }
}
assert(Object.keys(READERS).length >= 4, 'Project-specific coverage must not stop at two examples.');
assert(READERS.clanker.events.some((event) => event.key === 'tokenCreated'));
assert(READERS.pons.events.some((event) => event.key === 'tokenLaunched'));

const engram = seeds.projects.find((p) => p.id === 'engram');
const hook = engram.deployments.find((d) => d.role === 'hook');
const factory = engram.deployments.find((d) => d.role === 'factory');
assert.equal(readerDefinitionsForDeployment('engram', hook).reads.length, 6);
assert.equal(readerDefinitionsForDeployment('engram', factory).reads.length, 0, 'A project ABI must not leak onto its other contracts.');
assert.equal(readerDefinitionsForDeployment('engram', { ...hook, chainId: 8453 }).events.length, 0);
assert.equal(readerDefinitionsForDeployment('unknown', hook).reads.length, 0);
assert.equal(READERS.engram.reads.find((r) => r.key === 'model').zeroLabel, 'Default model');
assert.equal(READERS.engram.reads.find((r) => r.key === 'ownerAccrued').classification, 'accrued');
assert.equal(READERS.engram.events.find((e) => e.key === 'paymentRecorded').classification, 'transferred');
assert(!READERS.engram.reads.some((r) => r.key.includes('extracted')), 'Configuration must not claim measured extraction.');

// Fixed selector fixtures catch accidental spelling/case changes in the adapter.
// Declarations were compared against the published ff8860ba Hippocampus ABI.
const expectedSelectors = {
  'champion()': '0x44866955',
  'OWNER()': '0x117803e3',
  'HOOK_BPS()': '0xb1763fe5',
  'OWNER_BPS()': '0x27ecc790',
  'POT_BPS()': '0x77a64fd5',
  'ownerOwed()': '0x74064bb8',
};
for (const read of READERS.engram.reads) assert.equal(toFunctionSelector(read.signature), expectedSelectors[read.signature]);

// Indexed recipient and unindexed amount must remain separate during decoding.
const payment = READERS.engram.events.find((event) => event.key === 'paymentRecorded');
const paidAbi = parseAbiItem(payment.signature);
const recipient = '0x1111111111111111111111111111111111111111';
const paymentLog = decodeEventLog({
  abi: [paidAbi],
  topics: encodeEventTopics({ abi: [paidAbi], eventName: 'Paid', args: { to: recipient } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [1234567890123456789n]),
});
assert.equal(paymentLog.args[payment.recipientField], recipient);
assert.equal(paymentLog.args[payment.amountField], 1234567890123456789n);
assert.equal(payment.unit, 'wei');

const tokenCreated = READERS.clanker.events.find((event) => event.key === 'tokenCreated');
const createdAbi = parseAbiItem(tokenCreated.signature);
const tokenAddress = '0x2222222222222222222222222222222222222222';
const poolHook = '0x3333333333333333333333333333333333333333';
const poolId = `0x${'4'.repeat(64)}`;
const createdLog = decodeEventLog({
  abi: [createdAbi],
  topics: encodeEventTopics({ abi: [createdAbi], eventName: 'TokenCreated', args: { tokenAddress, tokenAdmin: recipient } }),
  data: encodeAbiParameters(createdAbi.inputs.filter((input) => !input.indexed), [
    recipient, 'https://example.invalid/image', '<untrusted name>', 'TEST', '{"untrusted":true}', 'creator text',
    -120n, poolHook, poolId, recipient, recipient, recipient, 0n, [],
  ]),
});
assert.equal(createdLog.args[tokenCreated.deploymentField], tokenAddress);
assert.equal(createdLog.args[tokenCreated.hookField], poolHook);
assert.equal(createdLog.args[tokenCreated.poolField], poolId);
assert.equal(createdLog.args.tokenName, '<untrusted name>', 'Keep submitted text data; do not promote it to verified identity.');

console.log(`Project registry and reader definitions pass: ${seeds.projects.length} projects, ${seeds.projects.reduce((sum, p) => sum + p.deployments.length, 0)} sourced deployments, ${Object.keys(READERS).length} source-bound adapters.`);
