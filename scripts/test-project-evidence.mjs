import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, parseAbiItem, toEventSelector } from 'viem';
import { READERS } from '../projects/reader-definitions.js';
import { projectId, publicUrl, createProjectRegistry, mergeProjectOverrides } from '../projects/registry.js';
import {
  SCAN_LIMIT, LOG_BLOCK_LIMIT, RETENTION_DAYS, digest, observeDeployment, observationChanges,
  latestProjectObservations, listProjectEvents, runProjectScan, followProject, projectFollows,
  deliverProjectEvents, projectEventSignal, projectMonitoring, verifyEventReceiptProof,
} from '../projects/evidence.js';

// Real SQLite checks SQL predicates, RETURNING, transactions, and uniqueness.
// No network, real Telegram messages, D1 writes, or wall-clock-dependent data.
class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(readFileSync(new URL('../drizzle/0003_project_evidence.sql',import.meta.url),'utf8'));
  }
  prepare(sql) {
    const database=this; let args=[];
    const statement={
      bind(...values) { args=values; return statement; },
      async first() { return database.sqlite.prepare(sql).get(...args) || null; },
      async all() { return {results:database.sqlite.prepare(sql).all(...args)}; },
      async run() { const result=database.sqlite.prepare(sql).run(...args); return {success:true,meta:{changes:Number(result.changes)}}; },
      _run() { const result=database.sqlite.prepare(sql).run(...args); return {success:true,meta:{changes:Number(result.changes)}}; },
    }; return statement;
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result=statements.map(s=>s._run()); this.sqlite.exec('COMMIT'); return result; }
    catch(error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const NOW=Date.parse('2026-10-07T21:00:00Z');
const DAY=86_400_000;
const A=`0x${'a'.repeat(40)}`;
const B=`0x${'b'.repeat(40)}`;
const C=`0x${'c'.repeat(40)}`;
const ZERO=`0x${'0'.repeat(40)}`;
const ENGRAM='0x0ee851f1fe2f4bdba79fee78969e329c136ca0cc';
const CLANKER='0xe85a59c628f7d27878aceb4bf3b35733630083a9';
const hash=n=>`0x${BigInt(n).toString(16).padStart(64,'0')}`;
const hex=n=>`0x${BigInt(n).toString(16)}`;
const word=value=>typeof value==='string' && value.startsWith('0x') ? `0x${value.slice(2).padStart(64,'0')}` : hash(value);
const selector=signature=>{ const abi=parseAbiItem(`function ${signature} view returns (uint256)`); return encodeFunctionData({abi:[abi],functionName:abi.name,args:[]}); };
const deployment=(address=A,chainId=8453,extra={})=>({address,chainId,role:'hook',monitor:true,...extra});
const project=(id='alpha',deps=[deployment()])=>({id,name:id[0].toUpperCase()+id.slice(1),website:`https://${id}-hooks.org/`,provenance:'researched project record',deployments:deps});
const registry=(projects=[project()])=>({schemaVersion:1,generatedAt:new Date(NOW).toISOString(),projects});
const env=()=>({DB:new D1()});

class RPC {
  constructor({tip=2000,chainId=8453}={}) { this.tip=tip;this.chainId=chainId;this.calls=[];this.headers=new Map();this.values=new Map();this.code='0x60016002';this.owner=word(A);this.implementation=word(ZERO);this.logs=[];this.failCode=false;this.failLogs=false;this.noFinalized=false;this.getLogs=null; }
  block(number=this.tip) { return {number:hex(number),hash:this.headers.get(number)||hash(number+100_000),timestamp:hex(Math.floor(NOW/1000)-(this.tip-number)*12),finality:'test pinned block'}; }
  rpc=async(chainId,method,params)=>{
    this.calls.push({chainId,method,params:structuredClone(params)});
    if(method==='eth_chainId') return hex(this.chainId);
    if(method==='eth_blockNumber') return hex(this.tip);
    if(method==='eth_getBlockByNumber') {
      if(params[0]==='finalized') { if(this.noFinalized) throw new Error('unsupported finality'); return this.block(); }
      return this.block(Number(BigInt(params[0])));
    }
    if(method==='eth_getCode') { if(this.failCode) throw new Error('unavailable'); return this.code; }
    if(method==='eth_getStorageAt') { if(this.implementation instanceof Error) throw this.implementation;return this.implementation; }
    if(method==='eth_call') {
      const result=params[0].data==='0x8da5cb5b' ? this.owner : this.values.get(params[0].data) ?? word(0);
      if(result instanceof Error) throw result;
      return result;
    }
    if(method==='eth_getLogs') {
      if(this.failLogs) throw new Error('logs unavailable');
      if(this.getLogs) return this.getLogs(params[0]);
      const from=Number(BigInt(params[0].fromBlock)); const to=Number(BigInt(params[0].toBlock));
      return this.logs.filter(log=>log.address.toLowerCase()===params[0].address.toLowerCase() && Number(BigInt(log.blockNumber))>=from && Number(BigInt(log.blockNumber))<=to);
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
}
function upgraded(rpc,number=rpc.tip,{address=A,implementation=B,logIndex=0,transactionHash=hash(number*100+logIndex),blockHash=rpc.block(number).hash,removed=false}={}) {
  return {address,blockNumber:hex(number),blockHash,transactionHash,logIndex:hex(logIndex),removed,
    topics:[toEventSelector(parseAbiItem('event Upgraded(address indexed implementation)')),word(implementation)],data:'0x'};
}
async function savedObservation(e,observation,{canonical=1}={}) {
  await e.DB.prepare('INSERT INTO project_observations(id,project_id,chain_id,address,block_number,block_hash,observed_at,payload_json,canonical) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(observation.id,observation.projectId,observation.chainId,observation.address,observation.blockNumber,observation.blockHash,Date.parse(observation.observedAt),JSON.stringify(observation),canonical).run();
}
async function addEvent(e,{id,projectId='alpha',at=NOW,blockNumber=2000,canonical=1,backfill=false,kind='observed_change'}={}) {
  const event={id:id||`event-${crypto.randomUUID()}`,projectId,projectName:projectId,title:'Implementation changed',kind,observedAt:new Date(at).toISOString(),chainId:8453,address:A,blockNumber,
    before:A,after:B,evidence:{scope:kind==='observed_change'?'between pinned observations':'contract event',fromBlock:blockNumber-1,toBlock:blockNumber,backfill}};
  await e.DB.prepare('INSERT INTO project_events(id,project_id,chain_id,address,block_number,block_hash,observed_at,kind,payload_json,canonical) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(event.id,projectId,8453,A,blockNumber,hash(blockNumber),at,kind,JSON.stringify(event),canonical).run();
  return event;
}
async function state(e,id='alpha',dep=deployment()) { return e.DB.prepare('SELECT * FROM project_scan_state WHERE target=?').bind(`${id}:${dep.chainId}:${dep.address}`).first(); }
function clone(value) { return structuredClone(value); }
const tests=[];
function test(name,fn) { tests.push([name,fn]); }

test('registry aliases, researched replacement, chain-aware deduplication, and provenance',async()=>{
  assert.equal(projectId('Diamond Hook Arrakis'),'arrakis');assert.equal(projectId('Bunny'),'bunni');assert.equal(projectId('StakeHut'),'steakhut');
  assert.equal(publicUrl('http://alpha-hooks.org'),null);assert.equal(publicUrl('https://user:secret@alpha-hooks.org'),null);
  const board={generatedAt:new Date(NOW-1000).toISOString(),projects:[
    {name:'Alpha',description:'Unverified legacy description',website:'https://legacy.org',hookId:`8453_${B}`},
    {name:'Community',description:'Community description',website:'https://community.org',hookId:`1_${C}`},
    {name:'Andre Cronje',description:'An individual, not project affiliation',website:'https://example.org'},
  ],hooks:[{chainId:8453,address:A,numberOfPools:17,numberOfSwaps:123},{chainId:1,address:A,numberOfPools:2}]};
  const researched={...project(),summary:'Researched summary',sources:[{label:'Official',url:'https://alpha-hooks.org/docs'},{label:'Bad',url:'javascript:alert(1)'}],deployments:[deployment(),deployment(A.toUpperCase().replace('0X','0x')),deployment(A,1),deployment('invalid',1),deployment(B,-1)]};
  const result=createProjectRegistry(board,{generatedAt:new Date(NOW).toISOString(),projects:[researched]});
  const alpha=result.projects.find(p=>p.id==='alpha');
  assert.equal(alpha.summary,'Researched summary');assert.equal(alpha.website,'https://alpha-hooks.org/');assert.equal(alpha.deployments.length,2);
  assert.equal(alpha.deployments.find(d=>d.chainId===8453).pools,17);assert.equal(alpha.deployments.find(d=>d.chainId===1).pools,2);
  assert.equal(alpha.deployments.find(d=>d.chainId===1).swaps,null);assert.equal(alpha.sources.length,1);
  assert.equal(alpha.provenance,'researched project record');assert.equal(alpha.coverage.linkedDeployments,2);
  const community=result.projects.find(p=>p.id==='community');assert.equal(community.deployments[0].monitor,false);assert.equal(community.provenance,'community directory record');
  assert.equal(result.projects.some(p=>p.name==='Andre Cronje'),false);
});
test('registry never infers affiliation from hook names and missing counts are not zero',async()=>{
  const result=createProjectRegistry({generatedAt:new Date(NOW).toISOString(),projects:[],hooks:[{chainId:8453,address:A,name:'Alpha'}]}, {projects:[{...project(),deployments:[]}]});
  assert.equal(result.projects[0].deployments.length,0);
  const absent=createProjectRegistry({projects:[],hooks:[]},{projects:[project()]});
  assert.equal('pools' in absent.projects[0].deployments[0],false);assert.equal('swaps' in absent.projects[0].deployments[0],false);
});
test('approved metadata maps preserve actual provenance and add projects without affiliations',async()=>{
  const original=createProjectRegistry({projects:[],hooks:[]},{projects:[{...project(),summary:'Original'}]});
  const result=mergeProjectOverrides(original,{
    alpha:{id:'alpha',name:'Updated Alpha',summary:'Reviewed description',website:'https://alpha-hooks.org/about',metadataProvenance:'community-reviewed',metadataUpdatedAt:new Date(NOW).toISOString(),metadataSourceUrl:'https://alpha-hooks.org/about',metadataRevision:3,deployments:[deployment(B)],observations:[{fees:0}],coverage:{monitoredDeployments:999}},
    newcomer:{id:'newcomer',name:'Newcomer',summary:'Reviewed new project',website:'https://newcomer.org/',metadataProvenance:'community-reviewed',metadataUpdatedAt:new Date(NOW).toISOString(),metadataSourceUrl:'https://newcomer.org/about',metadataRevision:1},
  });
  const alpha=result.projects.find(p=>p.id==='alpha');
  assert.equal(alpha.name,'Updated Alpha');assert.equal(alpha.metadataProvenance,'community-reviewed');assert.equal(alpha.metadataRevision,3);assert.equal(alpha.metadataUpdatedAt,new Date(NOW).toISOString());
  assert.deepEqual(alpha.deployments,original.projects[0].deployments);assert.equal('observations' in alpha,false);
  const added=result.projects.find(p=>p.id==='newcomer');assert.ok(added,'Direct-map reviewed project must be added');assert.deepEqual(added.deployments,[]);assert.equal(added.coverage.monitoredDeployments,0);
  assert.notEqual(added.provenance,'researched project record');
});
test('observations use one pinned block and fingerprint the exact runtime bytes',async()=>{
  const rpc=new RPC();const block=rpc.block();const result=await observeDeployment(project(),deployment(),{rpc:rpc.rpc,block,now:NOW});
  assert.equal(result.blockNumber,2000);assert.equal(result.blockHash,block.hash);assert.equal(result.observedAt,new Date(NOW).toISOString());
  assert.equal(result.fields.runtimeFingerprint,createHash('sha256').update(Buffer.from('60016002','hex')).digest('hex'));assert.equal(result.fields.bytecodeLength,4);
  assert.equal(result.fields.implementation,ZERO);assert.equal(result.probes.implementation.status,'observed');assert.ok(result.fieldMeta.implementation.zeroLabel);
  assert.equal(result.id,await digest(`alpha:8453:${A}:${block.hash}`));
  for (const call of rpc.calls) {
    assert.equal(call.chainId,8453);
    if (call.method==='eth_getStorageAt') assert.equal(call.params[2],block.number);
    if (['eth_getCode','eth_call'].includes(call.method)) assert.equal(call.params[1],block.number);
    if (call.method==='eth_getBlockByNumber') assert.equal(call.params[0],block.number);
    assert.equal(/send|sign|write/i.test(call.method),false);
  }
});
test('unavailable probes remain null while real zero model/configuration remain observed',async()=>{
  const rpc=new RPC({chainId:1});rpc.owner=new Error('owner reverted');rpc.implementation='0x01';
  rpc.values.set(selector('champion()'),word(ZERO));rpc.values.set(selector('OWNER()'),word(B));rpc.values.set(selector('HOOK_BPS()'),word(104));rpc.values.set(selector('OWNER_BPS()'),'0x');rpc.values.set(selector('POT_BPS()'),word(4));rpc.values.set(selector('ownerOwed()'),word(0));
  const result=await observeDeployment(project('engram',[deployment(ENGRAM,1)]),deployment(ENGRAM,1),{rpc:rpc.rpc,block:rpc.block(),now:NOW});
  assert.equal(result.fields.owner,null);assert.equal(result.probes.owner.status,'unavailable');assert.equal(result.fields.implementation,null);
  assert.equal(result.fields.model,ZERO);assert.equal(result.probes.model.status,'observed');assert.equal(result.fieldMeta.model.zeroLabel,'Default model');
  assert.equal(result.fields.configuredHookFee,'104');assert.equal(result.fieldMeta.configuredHookFee.unit,'bps');assert.equal(result.fieldMeta.configuredHookFee.basis,'ETH leg');
  assert.equal(result.fields.configuredOwnerShare,null);assert.equal(result.probes.configuredOwnerShare.status,'unavailable');
  assert.equal(result.fields.ownerAccrued,'0');assert.equal(result.probes.ownerAccrued.status,'observed');assert.equal(result.fieldMeta.ownerAccrued.classification,'accrued');
});
test('ABI readers are deployment-scoped and malformed boolean/address results are unavailable',async()=>{
  const rpc=new RPC();rpc.values.set(selector('deprecated()'),word(2));rpc.values.set(selector('teamFeeRecipient()'),`0x${'f'.repeat(64)}`);
  const observed=await observeDeployment(project('clanker'),deployment(CLANKER,8453),{rpc:rpc.rpc,block:rpc.block(),now:NOW});
  assert.equal(observed.fields.factoryDeprecated,null);assert.equal(observed.probes.factoryDeprecated.status,'unavailable');assert.equal(observed.fields.teamFeeRecipient,null);
  const unrelated=await observeDeployment(project('clanker'),deployment(A,8453),{rpc:rpc.rpc,block:rpc.block(),now:NOW});assert.equal('factoryDeprecated' in unrelated.fields,false);
  const differentChain=await observeDeployment(project('clanker'),deployment(CLANKER,1),{rpc:rpc.rpc,block:rpc.block(),now:NOW});assert.equal('factoryDeprecated' in differentChain.fields,false);
});
test('unsupported targets, malformed runtime/quantities, and changing source blocks fail closed',async()=>{
  const rpc=new RPC();
  await assert.rejects(()=>observeDeployment(project(),deployment(A,10),{rpc:rpc.rpc,block:rpc.block(),now:NOW}),/unsupported_observation_target/);
  await assert.rejects(()=>observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:{},now:NOW}),/missing_pinned_block/);
  await assert.rejects(()=>observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:{...rpc.block(),number:'0xffffffffffffffff'},now:NOW}),/quantity_overflow/);
  for(const code of ['0x','0x0','garbage']) { rpc.code=code;await assert.rejects(()=>observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:rpc.block(),now:NOW}),/deployed_code_unavailable/); }
  rpc.code='0x60016002';const pinned=rpc.block();rpc.headers.set(rpc.tip,hash(999));
  await assert.rejects(()=>observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:pinned,now:NOW}),/source_block_changed/);
});
test('project events normalize launch, implementation, fee, runtime, configuration, and outcome signals',()=>{
  assert.equal(projectEventSignal({field:'implementation',classification:'direct_observation'}),'implementation_change');
  assert.equal(projectEventSignal({field:'runtimeFingerprint',title:'Runtime SHA-256 changed',classification:'direct_observation'}),'runtime_change');
  assert.equal(projectEventSignal({kind:'tokenCreated',title:'Token deployed',classification:'executed',deploymentField:'tokenAddress'}),'factory_launch');
  assert.equal(projectEventSignal({kind:'launchFeeSet',title:'Launch fee configuration changed',classification:'configured'}),'fee_configuration_change');
  assert.equal(projectEventSignal({kind:'controllerAccepted',classification:'configured'}),'configuration_change');
  assert.equal(projectEventSignal({kind:'buybackBurnRecorded',classification:'executed'}),'outcome');
});
test('change detection requires same target, forward blocks, and two valid observations',async()=>{
  const rpc=new RPC();const previous=await observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:rpc.block(),now:NOW});
  rpc.tip++;rpc.owner=word(B);const current=await observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:rpc.block(),now:NOW+1000});
  assert.equal(observationChanges(null,current).length,0);assert.equal(observationChanges(previous,current).length,1);assert.equal(observationChanges(previous,current)[0].key,'owner');
  assert.equal(observationChanges(previous,{...current,chainId:1}).length,0);assert.equal(observationChanges(previous,{...current,address:B}).length,0);assert.equal(observationChanges(current,previous).length,0);assert.equal(observationChanges(previous,{...current,blockNumber:previous.blockNumber}).length,0);
  const unavailable=clone(current);unavailable.fields.owner=null;unavailable.probes.owner={status:'unavailable'};assert.equal(observationChanges(previous,unavailable).length,0);
  const firstKnown=clone(previous);firstKnown.fields.owner=null;firstKnown.probes.owner={status:'unavailable'};assert.equal(observationChanges(firstKnown,current).length,0);
  const accrued=clone(current);accrued.fieldMeta.owner.classification='accrued';assert.equal(observationChanges(previous,accrued).length,0);
  const lengthOnly=clone(previous);lengthOnly.blockNumber++;lengthOnly.fields.bytecodeLength++;assert.equal(observationChanges(previous,lengthOnly).length,0);
});
test('scan target cap, rotation, supported networks, and per-chain head reuse are bounded',async()=>{
  const e=env();const rpc=new RPC();const deps=Array.from({length:9},(_,i)=>deployment(`0x${(i+1).toString(16).padStart(40,'0')}`));
  const r=registry([project('alpha',[...deps,deployment(B,10),deployment(C,8453,{monitor:false})])]);
  const first=await runProjectScan(e,{registry:r,rpc:rpc.rpc,now:NOW,limit:999});assert.equal(first.checked,SCAN_LIMIT);assert.equal(first.failed,0);
  assert.equal(rpc.calls.filter(c=>c.method==='eth_chainId').length,1);assert.equal(rpc.calls.filter(c=>c.method==='eth_getBlockByNumber'&&c.params[0]==='finalized').length,1);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_scan_state').first()).n,SCAN_LIMIT);
  await runProjectScan(e,{registry:r,rpc:rpc.rpc,now:NOW+600_000});
  for(const dep of deps.slice(SCAN_LIMIT)) assert.ok(await state(e,'alpha',dep));
  const negative=await runProjectScan(env(),{registry:r,rpc:rpc.rpc,now:NOW,limit:-1});assert.ok(negative.checked<=SCAN_LIMIT,'Negative limit must not bypass scan cap');
});
test('baseline creates no change, forward reads create receipts, same-head retries deduplicate',async()=>{
  const e=env();const rpc=new RPC();const r=registry();
  assert.equal((await runProjectScan(e,{registry:r,rpc:rpc.rpc,now:NOW})).checked,1);assert.equal((await listProjectEvents(e)).length,0);
  rpc.tip++;rpc.owner=word(B);await runProjectScan(e,{registry:r,rpc:rpc.rpc,now:NOW+1000});
  const events=await listProjectEvents(e,'alpha');assert.equal(events.length,1);assert.equal(events[0].field,'owner');assert.equal(events[0].before,A);assert.equal(events[0].after,B);
  assert.equal(events[0].evidence.fromBlock,2000);assert.equal(events[0].evidence.toBlock,2001);assert.equal(events[0].transactionHash,undefined);
  assert.equal(events[0].evidence.before.blockHash,rpc.block(2000).hash);assert.equal(events[0].evidence.after.blockHash,rpc.block(2001).hash);
  await runProjectScan(e,{registry:r,rpc:rpc.rpc,now:NOW+2000});assert.equal((await listProjectEvents(e)).length,1);
  const latest=await latestProjectObservations(e,'alpha');assert.equal(latest.length,1);assert.equal(latest[0].blockNumber,2001);
});
test('failed refresh retains last good observation and recovery clears failure state',async()=>{
  const e=env();const rpc=new RPC();await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});const good=(await latestProjectObservations(e,'alpha'))[0];
  rpc.tip++;rpc.failCode=true;const failed=await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});assert.equal(failed.failed,1);assert.equal(failed.checked,0);
  assert.equal((await latestProjectObservations(e,'alpha'))[0].id,good.id);assert.equal((await state(e)).failure,'observation_unavailable');
  rpc.failCode=false;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+2000});assert.equal((await state(e)).failure,null);assert.equal((await state(e)).last_success_at,NOW+2000);
});
test('wrong RPC chain fails before evidence reads and finalized fallback is labeled',async()=>{
  const e=env();const wrong=new RPC({chainId:1});const result=await runProjectScan(e,{registry:registry(),rpc:wrong.rpc,now:NOW});assert.equal(result.failed,1);assert.equal(wrong.calls.some(c=>c.method==='eth_getCode'),false);
  const fallback=new RPC();fallback.noFinalized=true;await runProjectScan(e,{registry:registry(),rpc:fallback.rpc,now:NOW+1000});
  const observation=(await latestProjectObservations(e,'alpha'))[0];assert.equal(observation.blockNumber,fallback.tip-12);assert.equal(observation.finality,'12-block confirmation depth');
});
test('scan leases prevent overlap and are released even when targets fail',async()=>{
  const e=env();const rpc=new RPC();await e.DB.prepare("INSERT INTO project_scan_locks(id,owner,lease_until) VALUES('scan','other',?)").bind(NOW+60_000).run();
  assert.deepEqual(await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW}),{status:'skipped',reason:'scan_in_progress'});assert.equal(rpc.calls.length,0);
  rpc.failCode=true;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+61_000});assert.equal((await e.DB.prepare("SELECT lease_until FROM project_scan_locks WHERE id='scan'").first()).lease_until,0);
  assert.equal((await runProjectScan({}, {registry:registry(),rpc:rpc.rpc,now:NOW})).reason,'storage_unavailable');
});
test('logs scan bounded windows and failures never advance cursor or erase direct observations',async()=>{
  const e=env();const rpc=new RPC();await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});let request=rpc.calls.find(c=>c.method==='eth_getLogs').params[0];
  assert.equal(Number(BigInt(request.toBlock))-Number(BigInt(request.fromBlock))+1,LOG_BLOCK_LIMIT);assert.equal((await state(e)).log_cursor,2000);
  rpc.tip=4000;rpc.failLogs=true;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});assert.equal((await state(e)).log_cursor,2000);assert.equal((await latestProjectObservations(e,'alpha'))[0].blockNumber,4000);assert.equal((await state(e)).failure,null);assert.ok((await state(e)).log_failure);
  rpc.failLogs=false;rpc.calls=[];await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+2000});
  const ranges=rpc.calls.filter(c=>c.method==='eth_getLogs').map(c=>({from:Number(BigInt(c.params[0].fromBlock)),to:Number(BigInt(c.params[0].toBlock))}));
  assert.equal(ranges[0].from,2001);assert.ok(ranges.length<=4);
  for(let i=0;i<ranges.length;i++) {assert.ok(ranges[i].to-ranges[i].from+1<=LOG_BLOCK_LIMIT);if(i) assert.equal(ranges[i].from,ranges[i-1].to+1);}
  assert.equal((await state(e)).log_cursor,ranges.at(-1).to);assert.equal((await state(e)).failure,null);assert.equal((await state(e)).log_failure,null);
});
test('rate-limited event providers stop once without range-halving retry bursts',async()=>{
  const e=env();const rpc=new RPC();rpc.getLogs=()=>{throw new Error('event_rate_limited');};
  const result=await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.equal(result.logFailed,1);assert.equal(rpc.calls.filter(c=>c.method==='eth_getLogs').length,1);
  assert.equal((await state(e)).log_cursor,null);assert.equal((await state(e)).log_failure,'event_rate_limited');
  assert.equal((await latestProjectObservations(e,'alpha')).length,1);
});
test('event decoding retains transaction/log evidence and separates baseline from fresh events',async()=>{
  const e=env();const rpc=new RPC();const good=upgraded(rpc);rpc.logs=[good];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});const events=await listProjectEvents(e);assert.equal(events.length,1);const event=events[0];
  assert.equal(event.kind,'implementation_upgrade');assert.equal(event.after.implementation.toLowerCase(),B);assert.equal(event.transactionHash,good.transactionHash);assert.equal(event.evidence.logIndex,0);assert.equal(event.evidence.blockHash,good.blockHash);assert.equal(event.evidence.backfill,true);assert.deepEqual(event.evidence.raw,{topics:good.topics,data:good.data});
  rpc.tip++;rpc.logs=[upgraded(rpc,rpc.tip,{implementation:C})];await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});assert.equal((await listProjectEvents(e)).filter(x=>x.evidence.backfill===false).length,1);
});
test('removed, malformed, and mismatched-address logs invalidate their page without advancing cursor',async()=>{
  for(const mutation of [{removed:true},{transactionHash:'broken'},{address:B}]) {
    const e=env();const rpc=new RPC();const good=upgraded(rpc);rpc.getLogs=()=>[good,{...good,...mutation,logIndex:'0x1'}];
    await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
    assert.equal((await state(e)).log_cursor,null);assert.equal((await listProjectEvents(e)).length,0);assert.ok((await state(e)).log_failure);assert.equal((await latestProjectObservations(e,'alpha')).length,1);
  }
});
test('over-budget and out-of-window log batches fail closed without cursor advancement',async()=>{
  for(const mode of ['count','range']) {
    const e=env();const rpc=new RPC();rpc.getLogs=()=>mode==='count'?Array.from({length:161},()=>upgraded(rpc)):[upgraded(rpc,1)];
    await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});assert.equal((await state(e)).log_cursor,null);assert.equal((await state(e)).failure,null);assert.ok((await state(e)).log_failure);assert.equal((await listProjectEvents(e)).length,0);assert.equal((await latestProjectObservations(e,'alpha')).length,1);
  }
});
test('dense event ranges shrink within a bounded request budget and commit only the covered prefix',async()=>{
  const e=env();const rpc=new RPC();let attempts=0;const ranges=[];const covered=[];
  rpc.getLogs=filter=>{
    attempts++;const from=Number(BigInt(filter.fromBlock));const to=Number(BigInt(filter.toBlock));ranges.push({from,to});
    if(to-from+1>120) return Array.from({length:161},(_,i)=>upgraded(rpc,from,{logIndex:i}));
    covered.push({from,to});
    return [upgraded(rpc,from+1)];
  };
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.ok(attempts>=2&&attempts<=8,'Adaptive ranges must be bounded and actually shrink');
  assert.ok(covered.length>=1&&covered.length<=4,'At most four successful pages are committed per target');
  assert.equal(covered[0].from,ranges[0].from);
  for(let i=1;i<covered.length;i++) assert.equal(covered[i].from,covered[i-1].to+1,'Never skip a dense prefix');
  for(let i=1;i<ranges.length;i++) if(ranges[i].from===ranges[i-1].from) assert.ok(ranges[i].to<ranges[i-1].to);
  assert.equal((await state(e)).log_cursor,covered.at(-1).to);assert.ok((await state(e)).log_cursor<=rpc.tip);
  assert.equal((await listProjectEvents(e)).length,covered.length);assert.equal(Math.max(...(await listProjectEvents(e)).map(x=>x.evidence.toBlock)),covered.at(-1).to);
});
test('many event blocks cannot exhaust unbounded RPC work in one scheduled scan',async()=>{
  const e=env();const rpc=new RPC();
  rpc.getLogs=filter=>{
    const from=Number(BigInt(filter.fromBlock));const to=Number(BigInt(filter.toBlock));
    return Array.from({length:Math.min(160,to-from+1)},(_,i)=>upgraded(rpc,from+i));
  };
  const result=await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.equal(result.checked,1);assert.ok(rpc.calls.length<=240,'Whole-run RPC budget must be enforced, including event headers');
  assert.ok((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_events').first()).n<=160,'Whole-run contract-event write budget must be enforced');
  const cursor=(await state(e)).log_cursor;
  if(cursor!=null) for(const event of await listProjectEvents(e,null,100)) assert.ok(event.blockNumber<=cursor);
});
test('a known event that fails strict ABI decoding cannot silently advance history',async()=>{
  const e=env();const rpc=new RPC();const corrupt=upgraded(rpc,rpc.tip,{logIndex:1});corrupt.topics=[corrupt.topics[0]];rpc.logs=[upgraded(rpc),corrupt];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.equal((await state(e)).log_cursor,null);assert.equal((await listProjectEvents(e)).length,0,'No partial event batch is published on decode failure');assert.equal((await latestProjectObservations(e,'alpha')).length,1);
});
test('a later failing page preserves earlier committed log progress and the latest direct read',async()=>{
  const e=env();const rpc=new RPC();await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  rpc.tip=4000;const corrupt=upgraded(rpc,2700);corrupt.topics=[corrupt.topics[0]];rpc.logs=[upgraded(rpc,2200),corrupt];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
  assert.equal((await state(e)).log_cursor,2480);assert.equal((await latestProjectObservations(e,'alpha'))[0].blockNumber,4000);
  const events=await listProjectEvents(e);assert.equal(events.length,1);assert.equal(events[0].blockNumber,2200);assert.equal((await state(e)).failure,null);assert.equal((await state(e)).log_failure,'event_decode_failed');
});
test('intermediate event block hashes must agree with canonical headers, not just scan tip',async()=>{
  const e=env();const rpc=new RPC();rpc.logs=[upgraded(rpc,1800,{blockHash:hash(999999)})];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});assert.equal((await listProjectEvents(e)).length,0,'Wrong-branch log must not enter canonical feed');assert.equal((await state(e)).log_cursor,null);assert.equal((await state(e)).failure,null);assert.equal((await state(e)).log_failure,'event_branch_changed');
});
test('reorg invalidates replaced evidence and preserves unchanged replayed overlap events',async()=>{
  const e=env();const rpc=new RPC();const unchanged=upgraded(rpc,1600);const replaced=upgraded(rpc,1999,{implementation:B});rpc.logs=[unchanged,replaced];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});const old=(await latestProjectObservations(e,'alpha'))[0];assert.equal((await listProjectEvents(e)).length,2);
  rpc.headers.set(2000,hash(900_000));rpc.headers.set(1999,hash(899_999));rpc.tip=2010;const replacement=upgraded(rpc,1999,{implementation:C});rpc.logs=[unchanged,replacement];
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
  assert.equal((await e.DB.prepare('SELECT canonical FROM project_observations WHERE id=?').bind(old.id).first()).canonical,0);
  assert.equal((await latestProjectObservations(e,'alpha'))[0].blockNumber,2010);
  const events=await listProjectEvents(e);assert.equal(events.some(x=>x.blockNumber===1600),true,'Unchanged canonical overlap log must reactivate on replay');
  assert.equal(events.some(x=>x.evidence.blockHash===replaced.blockHash),false);assert.equal(events.some(x=>x.evidence.blockHash===replacement.blockHash),true);
});
test('an unavailable cursor header is not treated as proof of a reorg',async()=>{
  const e=env();const rpc=new RPC();await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  rpc.tip=4000;rpc.logs=[upgraded(rpc,2400)];await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
  const cursor=(await state(e)).log_cursor;assert.ok(cursor>=2480&&cursor<=4000);assert.equal((await listProjectEvents(e)).length,1);
  const baseRpc=rpc.rpc;rpc.rpc=async(chainId,method,params)=>method==='eth_getBlockByNumber'&&params[0]===hex(cursor)?null:baseRpc(chainId,method,params);
  rpc.tip++;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+2000});
  assert.equal((await state(e)).log_cursor,cursor);assert.equal((await listProjectEvents(e)).length,1,'Missing header must retain prior canonical event evidence');
});
test('historical catch-up ranges are labeled backfill and do not become fresh Telegram alerts',async()=>{
  const e=env();const rpc=new RPC();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  rpc.tip=4000;rpc.logs=[upgraded(rpc,2200)];await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
  const events=await listProjectEvents(e);assert.equal(events.length,1);assert.equal(events[0].evidence.backfill,true);
  let notifications=0;assert.equal((await deliverProjectEvents(e,{send:async()=>{notifications++;},now:NOW+1000})).sent,0);assert.equal(notifications,0);
});
test('retention preserves last canonical good read despite newer noncanonical evidence',async()=>{
  const e=env();const rpc=new RPC();const good=await observeDeployment(project(),deployment(),{rpc:rpc.rpc,block:rpc.block(100),now:NOW-(RETENTION_DAYS+5)*DAY});
  await savedObservation(e,good);const invalid={...good,id:'noncanonical-newer',blockNumber:200,blockHash:hash(777),observedAt:new Date(NOW-DAY).toISOString()};await savedObservation(e,invalid,{canonical:0});
  await addEvent(e,{id:'expired',at:NOW-(RETENTION_DAYS+1)*DAY});
  await runProjectScan(e,{registry:registry([]),rpc:rpc.rpc,now:NOW});
  assert.equal((await latestProjectObservations(e,'alpha'))[0]?.id,good.id);assert.equal((await listProjectEvents(e)).length,0);
});
test('event listing respects project scope and cannot bypass maximum with a negative limit',async()=>{
  const e=env();for(let i=0;i<110;i++) await addEvent(e,{id:`row-${i}`,projectId:i%2?'alpha':'beta',at:NOW+i});
  assert.equal((await listProjectEvents(e,'alpha')).length,55);assert.ok((await listProjectEvents(e,null,999)).length<=100);assert.ok((await listProjectEvents(e,null,-1)).length<=100);
  assert.deepEqual(await listProjectEvents({},'alpha'),[]);assert.deepEqual(await latestProjectObservations({},'alpha'),[]);
});
test('monitoring exposes observation freshness separately from event cursor lag and failure',async()=>{
  const e=env();const rpc=new RPC();const realNow=Date.now;Date.now=()=>NOW+3000;
  try {
    assert.equal((await projectMonitoring({},'alpha')).status,'not_started');assert.equal((await projectMonitoring(e,'alpha')).status,'not_started');
    await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
    const current=await projectMonitoring(e,'alpha');assert.equal(current.status,'current');assert.equal(current.targets[0].eventCursorBlock,2000);assert.equal(current.targets[0].eventLagBlocks,0);assert.equal(current.targets[0].lastObservationAt,new Date(NOW).toISOString());assert.equal(current.limits.maxRpcCalls,240);assert.equal(current.limits.eventPagesPerTarget,4);assert.equal(current.limits.maxScanSeconds,42);assert.equal(current.limits.maxContractEventsPerRun,160);
    rpc.tip=2500;rpc.failLogs=true;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
    const partial=await projectMonitoring(e,'alpha');assert.equal(partial.status,'partial');assert.equal(partial.targets[0].observationFailure,null);assert.ok(partial.targets[0].eventFailure);assert.equal(partial.targets[0].lastObservationAt,new Date(NOW+1000).toISOString());assert.equal(partial.targets[0].eventSuccessAt,new Date(NOW).toISOString());assert.equal(partial.targets[0].eventLagBlocks,500);
    rpc.tip=5000;rpc.failLogs=false;await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+2000});
    const behind=await projectMonitoring(e,'alpha');assert.equal(behind.status,'behind');assert.equal(behind.targets[0].eventFailure,null);assert.ok(behind.targets[0].eventLagBlocks>0);assert.equal(behind.targets[0].lastObservationAt,new Date(NOW+2000).toISOString());
    assert.equal((await projectMonitoring(e,'alph')).status,'not_started');
    Date.now=()=>NOW+2*60*60_000;assert.equal((await projectMonitoring(e,'alpha')).status,'partial');
  } finally {Date.now=realNow;}
});
test('monitoring can hide retired scan targets without deleting their historical evidence',async()=>{
  const e=env();const rpc=new RPC();await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  const current=await projectMonitoring(e,'alpha',[deployment(A,8453,{monitor:true})]);
  assert.equal(current.targets.length,1);assert.equal(current.targets[0].address,A);
  const retired=await projectMonitoring(e,'alpha',[deployment(B,8453,{monitor:true})]);
  assert.equal(retired.targets.length,0);assert.equal(retired.status,'not_started');
  assert.equal((await latestProjectObservations(e,'alpha')).length,1,'Retargeting must not erase historical observations.');
});
test('follows are private, user scoped, idempotent, and disabled follows disappear',async()=>{
  const e=env();await assert.rejects(()=>followProject(e,{projectId:'alpha',userId:'123',chatId:'-100',now:NOW}),/privately/);
  await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW});await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW+1});
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_follows').first()).n,1);assert.equal((await e.DB.prepare('SELECT created_at FROM project_follows').first()).created_at,NOW);assert.deepEqual(await projectFollows(e,'123'),['alpha']);assert.deepEqual(await projectFollows(e,'456'),[]);
  await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',enabled:false,now:NOW+2});assert.deepEqual(await projectFollows(e,'123'),[]);
});
test('follow cap is atomic and repeating an existing follow at capacity remains idempotent',async()=>{
  const e=env();
  // Release all ID hashes together. This deterministically exposes a vulnerable
  // count-then-insert race instead of relying on native crypto callback timing.
  const descriptor=Object.getOwnPropertyDescriptor(crypto.subtle,'digest');const nativeDigest=crypto.subtle.digest.bind(crypto.subtle);const pending=[];
  crypto.subtle.digest=async(...args)=>{const result=await nativeDigest(...args);return new Promise(resolve=>{pending.push(()=>resolve(result));if(pending.length===30) for(const release of pending) release();});};
  let outcomes;
  try {outcomes=await Promise.allSettled(Array.from({length:30},(_,i)=>followProject(e,{projectId:`project-${i}`,userId:'123',chatId:'123',now:NOW})));}
  finally {if(descriptor) Object.defineProperty(crypto.subtle,'digest',descriptor);else delete crypto.subtle.digest;}
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,20);assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_follows WHERE enabled=1').first()).n,20);
  const id=(await projectFollows(e,'123'))[0];assert.deepEqual(await followProject(e,{projectId:id,userId:'123',chatId:'123',now:NOW+1}),{projectId:id,enabled:true});
});
test('reenabling a follow starts a fresh notification window',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',enabled:false,now:NOW-4000});
  await addEvent(e,{id:'while-disabled',at:NOW-3000});await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-1000});await addEvent(e,{id:'after-refollow',at:NOW});
  const delivered=[];assert.equal((await deliverProjectEvents(e,{send:async(chat,text)=>delivered.push({chat,text}),now:NOW})).sent,1);assert.equal(delivered.length,1);
  assert.equal((await e.DB.prepare('SELECT created_at FROM project_follows').first()).created_at,NOW-1000);
});
test('delivery includes only new canonical nonbackfill events and never duplicates',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});
  await addEvent(e,{id:'eligible',at:NOW-1000});await addEvent(e,{id:'old',at:NOW-6000});await addEvent(e,{id:'old-day',at:NOW-DAY-1});await addEvent(e,{id:'backfill',at:NOW-1000,backfill:true});await addEvent(e,{id:'orphan',at:NOW-1000,canonical:0});await addEvent(e,{id:'other-project',projectId:'beta',at:NOW-1000});
  const sent=[];const send=async(chat,text,options)=>sent.push({chat,text,options});assert.deepEqual(await deliverProjectEvents(e,{send,now:NOW}),{sent:1});assert.deepEqual(await deliverProjectEvents(e,{send,now:NOW}),{sent:0});
  assert.equal(sent[0].chat,'123');assert.match(sent[0].text,/https:\/\/hookline\.world\/#\/projects\/alpha/);assert.match(sent[0].text,/observed between blocks/);
  assert.ok(sent[0].text.includes(`Contract: <code>${A}</code>`));assert.ok(sent[0].text.includes(`After: <code>${B}</code>`));
  assert.equal(sent[0].options.parse_mode,'HTML');assert.equal(sent[0].options.reply_markup.inline_keyboard[0][0].url,'https://hookline.world/#/projects/alpha');
});
test('project notifications escape markup in project names and field labels',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});
  const event=await addEvent(e,{id:'markup',at:NOW-1000});event.projectName='<a href="https://evil.invalid">Name</a>';event.title='Fee & <b>owner</b>';
  await e.DB.prepare('UPDATE project_events SET payload_json=? WHERE id=?').bind(JSON.stringify(event),event.id).run();
  const sent=[];await deliverProjectEvents(e,{send:async(chat,text)=>sent.push(text),now:NOW});
  assert.ok(sent[0].includes('&lt;a href="https://evil.invalid"&gt;Name&lt;/a&gt;'));
  assert.ok(sent[0].includes('Fee &amp; &lt;b&gt;owner&lt;/b&gt;'));assert.ok(!sent[0].includes('<a href='));
});
test('routine accruals stay in activity without becoming payment notifications',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});
  const accrual=await addEvent(e,{id:'accrual',at:NOW-1000});accrual.classification='accrued';
  await e.DB.prepare('UPDATE project_events SET payload_json=? WHERE id=?').bind(JSON.stringify(accrual),accrual.id).run();
  const burn=await addEvent(e,{id:'burn',at:NOW-500});Object.assign(burn,{kind:'contract_event',classification:'executed',after:{amount:'10'},amountField:'amount',unit:'raw-token-units'});
  await e.DB.prepare('UPDATE project_events SET payload_json=? WHERE id=?').bind(JSON.stringify(burn),burn.id).run();
  const sent=[];assert.equal((await deliverProjectEvents(e,{send:async(chat,text)=>sent.push(text),now:NOW})).sent,1);
  assert.match(sent[0],/Amount recorded: 10 raw token units/);assert.doesNotMatch(sent[0],/Payment recorded/);
  assert.equal((await listProjectEvents(e)).length,2);
});
test('newly collected receipts notify only people following before the actual chain event',async()=>{
  const e=env();const rpc=new RPC();const originalBlock=rpc.block.bind(rpc);
  rpc.block=function(number=this.tip) {return {...originalBlock(number),timestamp:hex(Math.floor(NOW/1000)+(number-2000)*12)};};
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW+15_000});
  await followProject(e,{projectId:'alpha',userId:'456',chatId:'456',now:NOW+5_000});
  rpc.tip=2001;rpc.logs=[upgraded(rpc)];await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+20_000});
  const events=await listProjectEvents(e);assert.equal(events.length,1);assert.equal(events[0].occurredAt,new Date(NOW+12_000).toISOString());assert.equal(events[0].evidence.backfill,false);
  const chats=[];assert.equal((await deliverProjectEvents(e,{send:async(chat)=>chats.push(chat),now:NOW+20_000})).sent,1);assert.deepEqual(chats,['456']);
});
test('uncertain Telegram delivery is recorded and not blindly retried',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});await addEvent(e,{id:'uncertain',at:NOW-1000});let attempts=0;const send=async()=>{attempts++;throw new Error('timeout after possible delivery');};
  assert.equal((await deliverProjectEvents(e,{send,now:NOW})).sent,0);assert.equal((await deliverProjectEvents(e,{send,now:NOW+1000})).sent,0);assert.equal(attempts,1);assert.equal((await e.DB.prepare('SELECT status FROM project_deliveries').first()).status,'delivery_uncertain');
});
test('parallel delivery workers claim each event once and batches stay bounded',async()=>{
  const e=env();await followProject(e,{projectId:'alpha',userId:'123',chatId:'123',now:NOW-5000});await addEvent(e,{id:'concurrent',at:NOW-1000});let count=0;
  const result=await Promise.all([deliverProjectEvents(e,{send:async()=>{count++;},now:NOW}),deliverProjectEvents(e,{send:async()=>{count++;},now:NOW})]);assert.equal(count,1);assert.equal(result.reduce((n,r)=>n+r.sent,0),1);
  for(let i=0;i<30;i++) await addEvent(e,{id:`batch-${i}`,at:NOW-500+i});
  assert.equal((await deliverProjectEvents(e,{send:async()=>{},now:NOW})).sent,25);assert.equal((await deliverProjectEvents(e,{send:async()=>{},now:NOW})).sent,5);assert.deepEqual(await deliverProjectEvents({},{send:async()=>{},now:NOW}),{sent:0});
});

test('a finalized RPC outage never silently switches to a newer twelve-block head',async()=>{
  const e=env();const rpc=new RPC();const original=rpc.rpc;
  rpc.rpc=async(chainId,method,params)=>{
    if(method==='eth_getBlockByNumber' && params[0]==='finalized') {rpc.calls.push({chainId,method,params});throw Object.assign(new Error('rpc_rate_limited'),{code:'rpc_rate_limited'});}
    return original(chainId,method,params);
  };
  const result=await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.equal(result.failed,1);assert.equal((await latestProjectObservations(e,'alpha')).length,0);
  assert.ok(!rpc.calls.some(call=>call.method==='eth_blockNumber'||call.method==='eth_getCode'));
});
test('transport pin and learned log width are passed through without skipping the original baseline window',async()=>{
  const e=env();const rpc=new RPC();let pinned;
  rpc.rpc.pinBlock=(chainId,block)=>{pinned={chainId,block};};rpc.rpc.suggestedLogRange=()=>100;rpc.rpc.upstreamRequests=()=>77;
  const result=await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});
  assert.equal(pinned.chainId,8453);assert.equal(pinned.block.hash,rpc.block().hash);assert.equal(result.upstreamRpcCalls,77);
  const requests=rpc.calls.filter(call=>call.method==='eth_getLogs');assert.equal(requests.length,4);
  assert.equal(Number(BigInt(requests[0].params[0].fromBlock)),1521);assert.equal((await state(e)).log_cursor,1920);assert.equal((await state(e)).log_status,'behind');
});
test('typed legitimate range errors split while transient provider errors stop at the existing cursor',async()=>{
  const e=env();const rpc=new RPC();rpc.getLogs=filter=>{
    const width=Number(BigInt(filter.toBlock)-BigInt(filter.fromBlock)+1n);
    if(width>100) throw Object.assign(new Error('rpc_log_range_limited'),{code:'rpc_log_range_limited',suggestedRange:100});
    return [];
  };
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW});assert.equal((await state(e)).log_cursor,1920);
  rpc.calls=[];rpc.getLogs=()=>{throw Object.assign(new Error('rpc_provider_unavailable'),{code:'rpc_provider_unavailable'});};
  await runProjectScan(e,{registry:registry(),rpc:rpc.rpc,now:NOW+1000});
  assert.equal(rpc.calls.filter(call=>call.method==='eth_getLogs').length,1);assert.equal((await state(e)).log_cursor,1920);assert.equal((await state(e)).log_failure,'event_provider_unavailable');
});

const clausFixture=JSON.parse(readFileSync(new URL('../projects/sources/claus-verified-2026-10-07.json',import.meta.url),'utf8'));
const clausBurnDefinition=READERS.claus.events.find(definition=>definition.key==='buybackBurnRecorded');
const clausDep=()=>deployment(clausFixture.hook,1);
function clausRpc({receipts=1}={}) {
  const fixture=clausFixture.burnReceiptFixture;const rpc=new RPC({tip:Number(BigInt(fixture.blockNumber)),chainId:1});
  rpc.implementation=word(clausFixture.implementation);rpc.headers.set(rpc.tip,fixture.blockHash);
  for(const read of clausFixture.reads) rpc.values.set(read.selector,word(read.observedValue.startsWith('0x')?read.observedValue:BigInt(read.observedValue)));
  const receiptMap=new Map();rpc.logs=[];
  for(let i=0;i<receipts;i++) {
    const receipt=clone(fixture),tx=receipts===1?fixture.transactionHash:hash(50000+i);
    receipt.transactionHash=tx;receipt.logs.forEach(log=>{log.transactionHash=tx;log.logIndex=hex(Number(BigInt(log.logIndex))+i*10);});
    receiptMap.set(tx,receipt);rpc.logs.push(receipt.logs[0]);
  }
  const original=rpc.rpc;
  rpc.rpc=async(chainId,method,params)=>{
    if(method==='eth_getTransactionReceipt') {rpc.calls.push({chainId,method,params});return receiptMap.get(params[0]) || null;}
    return original(chainId,method,params);
  };
  return rpc;
}
test('CLAUS supports twelve exact source reads and strict uint24 without applying a stale implementation ABI',async()=>{
  const rpc=clausRpc();const p=project('claus',[clausDep()]);
  const result=await observeDeployment(p,clausDep(),{rpc:rpc.rpc,block:rpc.block(),now:NOW});
  assert.equal(Object.keys(result.fields).length,16);assert.equal(result.fields.configuredBurnAllocation,'1500');assert.equal(result.fieldMeta.configuredBurnAllocation.unit,'ppm');assert.equal(result.fieldMeta.configuredBurnAllocation.denominator,1000000);
  assert.equal(result.fields.fomoFundsAccrued,'0');assert.equal(result.fields.nftRewardsContract,clausFixture.nft);
  rpc.values.set(selector('BURN_FEE_PIPS()'),word(0x1000000));
  const overflow=await observeDeployment(p,clausDep(),{rpc:rpc.rpc,block:rpc.block(),now:NOW});assert.equal(overflow.fields.configuredBurnAllocation,null);
  rpc.calls=[];rpc.implementation=word(B);
  const upgraded=await observeDeployment(p,clausDep(),{rpc:rpc.rpc,block:rpc.block(),now:NOW});
  assert.equal(upgraded.fields.configuredBurnAllocation,null);assert.equal(upgraded.probes.configuredBurnAllocation.reason,'reader_implementation_mismatch');
  assert.equal(rpc.calls.filter(call=>call.method==='eth_call').length,1,'Unknown implementation must only receive the generic owner probe, not twelve stale ABI calls');
});
test('actual CLAUS burn fixture confirms the exact hook-to-zero Transfer, not an equal-amount FOMO transfer',()=>{
  const receipt=clone(clausFixture.burnReceiptFixture),eventLog=receipt.logs[0];
  const args=decodeEventLog({abi:[parseAbiItem(clausBurnDefinition.signature)],data:eventLog.data,topics:eventLog.topics,strict:true}).args;
  const proof=verifyEventReceiptProof({definition:clausBurnDefinition,eventLog,receipt,args});
  assert.equal(proof.status,'transfer_confirmed');assert.equal(proof.amount,receipt.expected.burnedTokens);assert.equal(proof.transferLogIndex,Number(BigInt(receipt.expected.matchingTransferLogIndex)));
  assert.equal(proof.token,clausFixture.token);assert.equal(proof.to,ZERO);
  const fomoOnly={...receipt,logs:[receipt.logs[0],receipt.logs[2]]};
  assert.equal(verifyEventReceiptProof({definition:clausBurnDefinition,eventLog,receipt:fomoOnly,args}).status,'contract_reported');
  for(const changed of [{status:'0x0'},{blockHash:hash(99)},{transactionHash:hash(77)},{logs:receipt.logs.slice(1)}]) {
    assert.equal(verifyEventReceiptProof({definition:clausBurnDefinition,eventLog,receipt:{...receipt,...changed},args}).status,'contract_reported');
  }
  for(const changed of [{address:A},{data:word(1)},{removed:true},{blockHash:hash(5)},{topics:[receipt.logs[1].topics[0],word(B),word(ZERO)]}]) {
    const bad={...receipt,logs:[receipt.logs[0],{...receipt.logs[1],...changed}]};
    assert.equal(verifyEventReceiptProof({definition:clausBurnDefinition,eventLog,receipt:bad,args}).status,'contract_reported');
  }
});
test('receipt reconciliation is bounded to four per scan and preserves mixed event field units',async()=>{
  const e=env(),rpc=clausRpc({receipts:5});
  const result=await runProjectScan(e,{registry:registry([project('claus',[clausDep()])]),rpc:rpc.rpc,now:NOW});
  assert.equal(result.checked,1);assert.equal(result.logFailed,0);assert.equal(result.receiptProofsAttempted,4);
  assert.equal(rpc.calls.filter(call=>call.method==='eth_getTransactionReceipt').length,4);
  const events=await listProjectEvents(e,'claus');assert.equal(events.length,5);
  assert.equal(events.filter(event=>event.evidence.receiptProof.status==='transfer_confirmed').length,4);
  assert.equal(events.filter(event=>event.evidence.receiptProof.reason==='receipt_budget_reached').length,1);
  assert.equal(events[0].unit,'raw-token-units');assert.equal(events[0].fieldUnits.spentEth.unit,'wei');assert.equal(events[0].fieldUnits.burnedTokens.asset,clausFixture.token);
  const slotReads=rpc.calls.filter(call=>call.method==='eth_getStorageAt');assert.ok(slotReads.some(call=>call.params[2]===hex(rpc.tip-1)),'Historical ABI uses both block boundary implementations');
});
test('historical implementation mismatch retains a raw uninterpreted record without stale fee or burn claims',async()=>{
  const e=env(),rpc=clausRpc(),base=rpc.rpc;const eventBlock=rpc.tip;rpc.tip+=10;
  rpc.rpc=async(chainId,method,params)=>method==='eth_getStorageAt' && params[2]===hex(eventBlock)?word(B):base(chainId,method,params);
  const result=await runProjectScan(e,{registry:registry([project('claus',[clausDep()])]),rpc:rpc.rpc,now:NOW});
  assert.equal(result.logFailed,0);const event=(await listProjectEvents(e,'claus'))[0];
  assert.equal(event.kind,'uninterpreted_contract_event');assert.equal(event.after,null);assert.equal(event.amountField,null);assert.equal(event.classification,'uninterpreted');
  assert.equal(event.evidence.interpretation,'implementation_unverified');assert.equal(event.evidence.receiptProof,undefined);assert.ok(event.evidence.raw.data);
  assert.equal(rpc.calls.filter(call=>call.method==='eth_getTransactionReceipt').length,0);
});
test('same-block upgrades prevent attaching implementation-specific outcome interpretations',async()=>{
  const e=env(),rpc=clausRpc();rpc.logs.push(upgraded(rpc,rpc.tip,{address:clausFixture.hook,implementation:clausFixture.implementation,logIndex:1001}));
  await runProjectScan(e,{registry:registry([project('claus',[clausDep()])]),rpc:rpc.rpc,now:NOW});
  const events=await listProjectEvents(e,'claus');assert.equal(events.length,2);assert.ok(events.some(event=>event.kind==='implementation_upgrade'));
  assert.ok(events.some(event=>event.kind==='uninterpreted_contract_event'));assert.equal(rpc.calls.filter(call=>call.method==='eth_getTransactionReceipt').length,0);
});

let passed=0;const failures=[];
for(const [name,fn] of tests) {
  try {await fn();passed++;console.log(`PASS ${name}`);}
  catch(error) {failures.push({name,error});console.error(`FAIL ${name}\n${error.stack || error}`);}
}
console.log(`\n${passed}/${tests.length} project-evidence tests passed.`);
if(failures.length) process.exitCode=1;
