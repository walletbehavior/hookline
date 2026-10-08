import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  deliverRuntimeFamilyAppearances,
  followRuntimeFamily,
  recordRuntimeFamilyAppearances,
  runtimeFamilyFollows,
} from '../projects/mechanisms.js';

class D1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    for(const migration of ['0003_project_evidence.sql','0011_mechanism_subscriptions.sql']) {
      this.sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`,import.meta.url),'utf8'));
    }
  }
  prepare(sql) {
    const database=this;let values=[];
    const statement={bind(...args){values=args;return statement;},async first(){return database.sqlite.prepare(sql).get(...values)||null;},
      async all(){return {results:database.sqlite.prepare(sql).all(...values)};},async run(){return statement._run();},
      _run(){const result=database.sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}};
    return statement;
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {const result=statements.map(statement=>statement._run());this.sqlite.exec('COMMIT');return result;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}

const NOW=Date.parse('2026-10-07T22:00:00Z');
const A=`0x${'a'.repeat(40)}`,B=`0x${'b'.repeat(40)}`,C=`0x${'c'.repeat(40)}`,FINGERPRINT='f'.repeat(64);
const hash=value=>`0x${BigInt(value).toString(16).padStart(64,'0')}`;
const registry={projects:[{id:'alpha',name:'Alpha Hooks'}]};

async function saveObservation(env,{id,address,blockNumber,observedAt}) {
  const observation={id,projectId:'alpha',chainId:8453,address,blockNumber,blockHash:hash(blockNumber),
    observedAt:new Date(observedAt).toISOString(),readerVersion:'test-1',source:'Hookline direct chain RPC',fields:{runtimeFingerprint:FINGERPRINT}};
  await env.DB.prepare(`INSERT INTO project_observations
    (id,project_id,chain_id,address,block_number,block_hash,observed_at,payload_json,canonical)
    VALUES(?,?,?,?,?,?,?,?,1)`).bind(id,'alpha',8453,address,blockNumber,observation.blockHash,observedAt,JSON.stringify(observation)).run();
}

const env={DB:new D1()};
await saveObservation(env,{id:'old',address:A,blockNumber:100,observedAt:NOW-1000});
assert.deepEqual(await recordRuntimeFamilyAppearances(env,{registry,now:NOW}),{recorded:1});
assert.deepEqual(await recordRuntimeFamilyAppearances(env,{registry,now:NOW}),{recorded:0},'Recorded appearances must not monopolize later scan batches.');

await assert.rejects(()=>followRuntimeFamily(env,{fingerprint:FINGERPRINT,userId:'10',chatId:'11'}),/privately/);
await followRuntimeFamily(env,{fingerprint:FINGERPRINT,label:'Alpha runtime',deployments:[`8453_${A}`,`8453_${B}`],userId:'10',chatId:'10',now:NOW});
assert.equal((await runtimeFamilyFollows(env,'10'))[0].label,'Alpha runtime');
let sent=[];
assert.deepEqual(await deliverRuntimeFamilyAppearances(env,{send:async(...args)=>sent.push(args),now:NOW}),{sent:0},'Existing family history seeds silently.');

await saveObservation(env,{id:'new',address:B,blockNumber:110,observedAt:NOW+1000});
assert.deepEqual(await recordRuntimeFamilyAppearances(env,{registry,now:NOW+1000}),{recorded:1});
assert.deepEqual(await deliverRuntimeFamilyAppearances(env,{send:async(...args)=>sent.push(args),now:NOW+1000}),{sent:0},'Deployments already present in the family snapshot must stay silent even if direct monitoring arrives later.');
await saveObservation(env,{id:'newer',address:C,blockNumber:120,observedAt:NOW+2000});
assert.deepEqual(await recordRuntimeFamilyAppearances(env,{registry,now:NOW+2000}),{recorded:1});
assert.deepEqual(await deliverRuntimeFamilyAppearances(env,{send:async(...args)=>sent.push(args),now:NOW+2000}),{sent:1});
assert.equal(sent.length,1);assert.match(sent[0][1],/New Hookline-observed runtime-family appearance/);
assert.match(sent[0][1],/not proof of deployment time/);assert(sent[0][1].includes(`<code>${C}</code>`));
assert.ok(Buffer.byteLength(sent[0][2].reply_markup.inline_keyboard[0][1].callback_data)<=64);
assert.deepEqual(await deliverRuntimeFamilyAppearances(env,{send:async(...args)=>sent.push(args),now:NOW+2500}),{sent:0},'A delivered appearance must never repeat.');

await followRuntimeFamily(env,{fingerprint:FINGERPRINT,label:'Alpha runtime',userId:'10',chatId:'10',enabled:false,now:NOW+3000});
assert.equal((await runtimeFamilyFollows(env,'10'))[0].enabled,0);
console.log('Mechanism subscriptions: private runtime follows, silent history, bounded callbacks, and idempotent new-appearance delivery passed.');
