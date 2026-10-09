import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateManifest, submitManifest, getManifestStatus, reviewManifest, handleManifestRequest } from '../projects/manifests.js';

class D1 {
  constructor() { this.sqlite=new DatabaseSync(':memory:'); this.sqlite.exec(readFileSync(new URL('../drizzle/0012_project_manifest_submissions.sql',import.meta.url),'utf8')); }
  prepare(sql) { const database=this; let args=[]; const statement={bind(...values){args=values;return statement;},async first(){return database.sqlite.prepare(sql).get(...args) || null;},async all(){return {results:database.sqlite.prepare(sql).all(...args)};},async run(){const result=database.sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},_run(){const result=database.sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}}; return statement; }
  async batch(statements) { this.sqlite.exec('BEGIN'); try { const result=statements.map(s=>s._run()); this.sqlite.exec('COMMIT'); return result; } catch(error) { this.sqlite.exec('ROLLBACK'); throw error; } }
}
const NOW=Date.parse('2026-10-09T12:00:00.000Z');
const manifest={schemaVersion:1,projectId:'qhooks-foundry',name:'Qhooks Foundry',summary:'A claimed factory release.',website:'https://qhooks.example.org/',sources:[{label:'Official release',url:'https://qhooks.example.org/releases/1'}],deployments:[{chain:'evm',chainId:8453,address:'0x1234567890123456789012345678901234567890',role:'factory',sourceUrl:'https://qhooks.example.org/contracts'}],issuedAt:'2026-10-09T11:00:00.000Z',expiresAt:'2026-10-20T12:00:00.000Z'};
const env=()=>({DB:new D1(),PROJECT_MANIFEST_REVIEW_TOKEN:'x'.repeat(32)});
const rejects=async(fn,code)=>assert.rejects(fn,error=>error.code===code,code);
const tests=[]; const test=(name,fn)=>tests.push([name,fn]);

test('strict v1 schema enforces HTTPS sources, roles, chain addresses, and expiry',()=>{
  assert.equal(validateManifest(manifest,{now:NOW}).projectId,'qhooks-foundry');
  for(const changed of [
    {...manifest,schemaVersion:2}, {...manifest,extra:true}, {...manifest,sources:[{label:'x',url:'http://qhooks.example.org'}]},
    {...manifest,deployments:[{...manifest.deployments[0],role:'watched'}]}, {...manifest,deployments:[{...manifest.deployments[0],address:'not-an-address'}]},
    {...manifest,expiresAt:'2026-12-20T12:00:00.000Z'}, {...manifest,issuedAt:'2026-09-01T12:00:00.000Z'},
  ]) assert.throws(()=>validateManifest(changed,{now:NOW}));
  assert.throws(()=>validateManifest({...manifest,deployments:[{chain:'solana',chainId:1,address:'11111111111111111111111111111111',role:'program',sourceUrl:'https://qhooks.example.org/p'}]},{now:NOW}));
});
test('submissions are private claims and never publish registry/monitoring authority',async()=>{
  const e=env(), result=await submitManifest(e,manifest,{now:NOW,actorId:'actor'});
  assert.equal(result.status,'pending_review'); assert.equal(result.receiptToken.length,43); assert.match(result.reviewScope,/not public registry/i);
  const row=await e.DB.prepare('SELECT * FROM project_manifest_submissions WHERE id=?').bind(result.id).first();
  assert.equal(row.status,'pending_review'); assert.equal(row.capability_hash===result.receiptToken,false); assert.equal(row.manifest_json.includes('monitor'),false);
  const status=await getManifestStatus(e,result.id,{receiptToken:result.receiptToken,now:NOW});
  assert.equal('manifest' in status,false); assert.equal('actor_key' in status,false);
  await rejects(()=>getManifestStatus(e,result.id,{receiptToken:'a'.repeat(43),now:NOW}),'manifest_not_found');
});
test('duplicates, bounded rate limits, and receipt privacy fail closed',async()=>{
  const e=env(); await submitManifest(e,manifest,{now:NOW,actorId:'a'});
  await rejects(()=>submitManifest(e,manifest,{now:NOW,actorId:'b'}),'duplicate_manifest');
  for(let i=1;i<=8;i++) await submitManifest(e,{...manifest,projectId:`qhooks-${i}`,name:`Qhooks ${i}`},{now:NOW,actorId:'same'});
  await rejects(()=>submitManifest(e,{...manifest,projectId:'qhooks-over',name:'Over'},{now:NOW,actorId:'same'}),'submission_limit');
  const request=new Request('https://hookline.world/api/project-manifests?receiptToken=nope');
  const response=await handleManifestRequest(request,e,{now:NOW}); assert.equal(response.status,400); assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('review access is separate and approval remains non-public audit evidence',async()=>{
  const e=env(), result=await submitManifest(e,manifest,{now:NOW});
  const unauthorized=await handleManifestRequest(new Request('https://hookline.world/api/project-manifests/review-queue'),e,{now:NOW}); assert.equal(unauthorized.status,403);
  const reviewed=await reviewManifest(e,result.id,{decision:'approve',reason:'Official release page names this factory.',evidenceUrl:'https://qhooks.example.org/releases/1'},{now:NOW,reviewerId:'reviewer'});
  assert.equal(reviewed.status,'reviewed'); assert.match(reviewed.reviewScope,/separate evidence workflow/i);
  const row=await e.DB.prepare('SELECT status,reviewer_id FROM project_manifest_submissions WHERE id=?').bind(result.id).first(); assert.equal(row.status,'reviewed'); assert.equal(row.reviewer_id,'reviewer');
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_manifest_audit WHERE submission_id=?').bind(result.id).first()).n,2);
});

let failed=0; for(const [name,fn] of tests) { try { await fn(); console.log(`ok - ${name}`); } catch(error) { failed++; console.error(`not ok - ${name}`); console.error(error); } }
if(failed) process.exitCode=1;
