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
  const maxReads=reader.maxReads ?? 6;
  assert(Number.isInteger(maxReads) && maxReads>0 && maxReads<=12, 'Explicit adapters may expand to twelve reads without removing the global scan budget.');
  for(const deployment of project.deployments) {
    const matched=readerDefinitionsForDeployment(projectId,deployment);
    assert(matched.reads.length<=maxReads, 'Do not create an unbounded per-observation RPC fan-out.');
    assert(matched.events.length<=6, 'Bound event topics per emitting deployment, not per project label.');
  }
  assert.equal(new Set([...reader.reads, ...reader.events].map((d) => d.key)).size, reader.reads.length + reader.events.length);
  for (const definition of [...reader.reads, ...reader.events]) {
    assert(project.deployments.some((d) => d.chainId === definition.chainId && d.address === definition.address));
    safeHttps(definition.sourceUrl);
    assert(definition.sourceVersion);
    assert(definition.label && definition.description);
    if(definition.implementationAddress) assert.match(definition.implementationAddress,addressPattern);
  }
  for (const read of reader.reads) {
    assert.match(read.signature, /^[A-Za-z_][A-Za-z0-9_]*\(\)$/);
    assert(['address', 'uint24', 'uint256', 'bool'].includes(read.returns));
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
    assert(['configured', 'accrued', 'transferred', 'executed', 'deferred'].includes(event.classification));
    if (event.amountField) assert(abi.inputs.some((input) => input.name === event.amountField && input.type === 'uint256'));
    if (event.recipientField) assert(abi.inputs.some((input) => input.name === event.recipientField && input.type === 'address'));
    for(const key of Object.keys(event.fieldUnits || {})) assert(abi.inputs.some(input=>input.name===key),`Units refer to a decoded field: ${key}`);
    if(event.receiptProof) {
      const proof=event.receiptProof;
      assert.equal(proof.kind,'erc20_transfer');
      [proof.token,proof.from,proof.to].forEach(address=>assert.match(address,addressPattern));
      assert(abi.inputs.some(input=>input.name===proof.amountField && input.type==='uint256'));
    }
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

const clausSource=JSON.parse(await readFile(new URL('../projects/sources/claus-verified-2026-10-07.json',import.meta.url),'utf8'));
const clausProject=seeds.projects.find(project=>project.id==='claus');
const clausHook=clausProject.deployments.find(deployment=>deployment.address===clausSource.hook);
const clausNft=clausProject.deployments.find(deployment=>deployment.address===clausSource.nft);
assert(clausHook && clausNft, 'Hook and NFT reward contract must have independent canonical deployment records.');
assert.equal(READERS.claus.maxReads,12);
assert.equal(readerDefinitionsForDeployment('claus',clausHook).reads.length,12);
assert.equal(readerDefinitionsForDeployment('claus',clausHook).events.length,6);
assert.equal(readerDefinitionsForDeployment('claus',clausNft).events.length,3);
assert.equal(readerDefinitionsForDeployment('claus',{...clausHook,chainId:8453}).reads.length,0);
assert.equal(readerDefinitionsForDeployment('claus',{...clausHook,address:clausSource.implementation}).reads.length,0,'Call the proxy storage, never the implementation instance.');
assert.equal(readerDefinitionsForDeployment('claus',{chainId:1,address:clausSource.token}).events.length,0,'Do not apply hook or NFT ABI to the token.');
for(const read of READERS.claus.reads) {
  const source=clausSource.reads.find(item=>item.signature===read.signature);
  assert(source,`${read.signature} must be in the verified ABI fixture.`);
  assert.equal(read.returns,source.returns,'Preserve exact uint24 instead of silently declaring uint256.');
  assert.equal(toFunctionSelector(read.signature),source.selector);
  assert.equal(read.implementationAddress,clausSource.implementation);
  assert.equal(read.address,clausSource.hook);
  assert(!('value' in read) && !('defaultValue' in read),'No source constants or fixture observations may become live defaults.');
  if(read.returns==='uint24') {
    assert.equal(read.unit,'ppm');assert.equal(read.denominator,1000000);assert.equal(read.basis,'gross ETH');
    assert.equal(read.classification,'configuration');
  }
}
const configuredAllocations=READERS.claus.reads.filter(read=>read.returns==='uint24');
assert.equal(configuredAllocations.length,5);
assert.equal(configuredAllocations.reduce((sum,read)=>sum+BigInt(clausSource.reads.find(item=>item.signature===read.signature).observedValue),0n),20000n,'The five getters cover project allocation, not total hook charge.');
assert(!READERS.claus.reads.some(read=>/total|platform/i.test(read.key)),'No invented total/platform public getter.');
for(const key of ['projectFeesAccrued','burnFundsAccrued','liquidityFundsAccrued','fomoFundsAccrued']) assert.equal(READERS.claus.reads.find(read=>read.key===key).classification,'accrued');
for(const event of READERS.claus.events) {
  const source=clausSource.events.find(item=>item.signature===event.signature);
  assert(source,`${event.key} signature must match verified ABI including indexed fields.`);
  assert.equal(toEventSelector(parseAbiItem(event.signature)),source.topic);
  assert.equal(event.address,clausSource[source.emitter]);
  if(source.emitter==='hook') assert.equal(event.implementationAddress,clausSource.implementation);
  else assert.equal(event.implementationAddress,undefined,'The NFT reward deployment is verified non-proxy.');
}
const burnDefinition=READERS.claus.events.find(event=>event.key==='buybackBurnRecorded');
const fomoDefinition=READERS.claus.events.find(event=>event.key==='fomoBuybackRecorded');
assert.equal(burnDefinition.recipientField,undefined,'BuybackBurn.sender is an executor, not a recipient.');
assert.equal(burnDefinition.unit,'raw-token-units');
assert.equal(burnDefinition.asset,clausSource.token);
assert.equal(burnDefinition.fieldUnits.spentEth.unit,'wei');
assert.equal(burnDefinition.fieldUnits.burnedTokens.decimals,18);
assert.equal(fomoDefinition.recipientField,'recipient');
assert.equal(fomoDefinition.amountField,'sentTokens');
assert.equal(fomoDefinition.receiptProof,undefined,'Only the verified burn-transfer proof is enabled in this release.');
assert.deepEqual(burnDefinition.receiptProof,{kind:'erc20_transfer',token:clausSource.token,from:clausSource.hook,to:'0x'+'0'.repeat(40),amountField:'burnedTokens'});

// This is a real bounded-range RPC log/receipt fixture, not a made-up success.
// An equal-sized FOMO output in the same receipt must not satisfy the burn proof.
const receipt=clausSource.burnReceiptFixture;
assert.equal(receipt.status,'0x1');
assert.equal(Number(BigInt(receipt.blockNumber)),26143452);
const burnLog=receipt.logs.find(log=>log.address===clausSource.hook);
const burnArgs=decodeEventLog({abi:[parseAbiItem(burnDefinition.signature)],topics:burnLog.topics,data:burnLog.data,strict:true}).args;
for(const [key,value] of Object.entries(receipt.expected).filter(([key])=>['spentEth','burnedTokens','pendingEth'].includes(key))) assert.equal(burnArgs[key].toString(),value);
const transferAbi=parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const decodedTransfers=receipt.logs.filter(log=>log.address===clausSource.token).map(log=>({log,args:decodeEventLog({abi:[transferAbi],topics:log.topics,data:log.data,strict:true}).args}));
const matching=decodedTransfers.filter(({log,args})=>log.transactionHash===burnLog.transactionHash && log.blockHash===burnLog.blockHash && args.from.toLowerCase()===clausSource.hook && args.to===burnDefinition.receiptProof.to && args.value===burnArgs.burnedTokens);
assert.equal(matching.length,1);
assert.equal(matching[0].log.logIndex,receipt.expected.matchingTransferLogIndex);
const fomoTransfer=decodedTransfers.find(item=>item.log.logIndex===receipt.expected.unrelatedFomoTransferLogIndex);
assert.equal(fomoTransfer.args.value,burnArgs.burnedTokens,'The distracting transfer has exactly the same amount.');
assert.notEqual(fomoTransfer.args.to,burnDefinition.receiptProof.to,'Recipient and source binding are essential.');

// Accrual, successful contract-reported payment, and deferred payment must
// remain separate categories even though the same amount/epoch may recur.
for(const [key,eventName,classification] of [
  ['nftRewardPaymentRecorded','NftRewardPaid','transferred'],
  ['nftRewardPaymentDeferred','NftRewardDeferred','deferred'],
]) {
  const definition=READERS.claus.events.find(event=>event.key===key),abi=parseAbiItem(definition.signature);
  const args=decodeEventLog({abi:[abi],topics:encodeEventTopics({abi:[abi],eventName,args:{epoch:7n,account:recipient}}),data:encodeAbiParameters([{type:'uint256'}],[1000000000000000001n]),strict:true}).args;
  assert.equal(definition.address,clausSource.nft);
  assert.equal(definition.classification,classification);
  assert.equal(definition.recipientField,'account');
  assert.equal(args[definition.recipientField],recipient);
  assert.equal(args[definition.amountField],1000000000000000001n);
  assert.equal(args.epoch,7n);
  assert.equal(definition.receiptProof,undefined,'Native payment is a decoded contract record, not an ERC-20 transfer proof.');
}
assert.equal(READERS.claus.events.find(event=>event.key==='nftFeesAccrued').classification,'accrued');
assert.equal(READERS.claus.events.find(event=>event.key==='nftRewardsAccrued').classification,'accrued');
assert(!READERS.claus.events.some(event=>event.signature.includes('ProjectFeesClaimed')),'An inherited but unused ABI event is not an active payout source.');

console.log(`Project registry and reader definitions pass: ${seeds.projects.length} projects, ${seeds.projects.reduce((sum, p) => sum + p.deployments.length, 0)} sourced deployments, ${Object.keys(READERS).length} source-bound adapters.`);
