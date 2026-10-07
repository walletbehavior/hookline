import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  validateContribution, validatePublicHostname, submitContribution, getContributionStatus,
  listActorSubmissions, issueClaimChallenge, verifyClaim, updateClaimedMetadata,
  revokeContribution, listReviewQueue, reviewContribution, readProjectOverrides,
  handleContributionRequest,
  readContributionAudit,
} from '../projects/contributions.js';

// SQLite executes real constraints, transactions, RETURNING, and contention predicates.
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); this.sqlite.exec(readFileSync(new URL('../drizzle/0002_project_contributions.sql',import.meta.url),'utf8')); }
  prepare(sql) {
    const database=this; let args=[];
    const statement={bind(...values) { args=values; return statement; },
      async first() { return database.sqlite.prepare(sql).get(...args) || null; },
      async all() { return {results:database.sqlite.prepare(sql).all(...args)}; },
      async run() { const result=database.sqlite.prepare(sql).run(...args); return {success:true,meta:{changes:Number(result.changes)}}; },
      _run() { const result=database.sqlite.prepare(sql).run(...args); return {success:true,meta:{changes:Number(result.changes)}}; },
    }; return statement;
  }
  async batch(statements) { this.sqlite.exec('BEGIN'); try { const result=statements.map(s => s._run()); this.sqlite.exec('COMMIT'); return result; } catch(error) { this.sqlite.exec('ROLLBACK'); throw error; } }
}
const NOW=Date.parse('2026-10-07T20:00:00Z');
const DAY=86_400_000;
const projects={alpha:{id:'alpha',name:'Alpha',website:'https://alpha-hooks.org/',provenance:'researched project record'},beta:{id:'beta',website:'https://beta-hooks.org/'}};
const getProject=async id => projects[id] || null;
function env() { return {DB:new D1()}; }
const projectInput={kind:'project',name:'Useful Hooks',website:'https://useful-hooks.org/',description:'An independently submitted project.',agreement:true};
const claimInput={kind:'claim',projectId:'alpha',agreement:true};
function opts(extra={}) { return {getProject,now:NOW,...extra}; }
async function rejectsCode(fn,code) { await assert.rejects(fn,error => error.code===code,code); }
function dnsFetch(record,{name='_hookline.alpha-hooks.org.',status=0,type=16,throwError=false}={}) {
  return async (url,options) => {
    assert.equal(new URL(url).origin,'https://cloudflare-dns.com');
    assert.equal(new URL(url).pathname,'/dns-query');
    assert.equal(new URL(url).searchParams.get('type'),'TXT');
    assert.equal(options.redirect,'error');
    assert.ok(options.signal);
    if (throwError) throw new Error('offline');
    return new Response(JSON.stringify({Status:status,Answer:[{name,type,data:JSON.stringify(record)}]}),{headers:{'content-type':'application/dns-json'}});
  };
}
async function owner(e,extra={}) {
  const submitted=await submitContribution(e,claimInput,opts({actorId:'claimant',...extra}));
  await verifyClaim(e,submitted.id,opts({receiptToken:submitted.receiptToken,fetcher:dnsFetch(submitted.verification.value),...extra}));
  return submitted;
}
const tests=[];
function test(name,fn) { tests.push([name,fn]); }

test('strict validator has no email dependency and permits DNS claim without proof URL',async()=>{
  assert.equal(validateContribution(projectInput).contact,'');
  assert.equal(validateContribution(claimInput).proofUrl,'');
  assert.equal(validateContribution({...projectInput,contact:'@project_team'}).contact,'@project_team');
  for (const [input,code] of [
    [{...projectInput,contact:'owner@example.com'},'invalid_contact'],
    [{...projectInput,status:'approved'},'unknown_field'],
    [{...projectInput,telegramUserId:'123'},'unknown_field'],
    [{...projectInput,fees:0},'unknown_field'],
    [{...projectInput,agreement:false},'agreement_required'],
    [{...projectInput,websiteTrap:'spam'},'invalid_submission'],
    [{...projectInput,description:'<script>alert(1)</script>'},'invalid_field'],
    [{...projectInput,name:'x'.repeat(101)},'invalid_field'],
    [{kind:'correction',projectId:'alpha',agreement:true},'invalid_field'],
    [{...projectInput,contracts:[{chainId:1,address:'0x'+'a'.repeat(40),verified:true}]},'unknown_field'],
  ]) await rejectsCode(async()=>validateContribution(input),code);
});
test('SSRF-shaped and credential-bearing URLs rejected before any fetch',async()=>{
  for (const website of ['http://alpha-hooks.org','https://localhost','https://127.0.0.1','https://[::1]','https://2130706433','https://user:pass@alpha-hooks.org','https://alpha-hooks.org:8443','https://host.internal']) {
    assert.throws(()=>validateContribution({...projectInput,website}));
  }
  assert.throws(()=>validatePublicHostname('a..com'));
  assert.equal(validatePublicHostname('alpha-hooks.org'),'alpha-hooks.org');
});
test('stores private submission and hashes capability, exposes no public list',async()=>{
  const e=env(); const result=await submitContribution(e,{...projectInput,contact:'@project_team'},opts({actorId:'one'}));
  assert.equal(result.status,'pending_review'); assert.equal(result.receiptToken.length,43);
  const row=await e.DB.prepare('SELECT * FROM project_submissions WHERE id=?').bind(result.id).first();
  assert.notEqual(row.capability_hash,result.receiptToken);
  assert.equal(JSON.stringify(row).includes(result.receiptToken),false);
  assert.equal(row.actor_key.includes('one'),false);
  const response=await handleContributionRequest(new Request('https://hookline.world/api/project-submissions'),e,opts());
  assert.equal(response.status,404);
  const status=await getContributionStatus(e,result.id,opts({receiptToken:result.receiptToken}));
  assert.equal('contact' in status,false); assert.equal('payload' in status,false);
  assert.deepEqual(Object.keys(await readProjectOverrides(e)),[]);
});
test('receipt authentication is submission scoped and query credentials never accepted',async()=>{
  const e=env(); const a=await submitContribution(e,projectInput,opts({actorId:'a'})); const b=await submitContribution(e,projectInput,opts({actorId:'b'}));
  await rejectsCode(()=>getContributionStatus(e,a.id,opts()),'submission_not_found');
  await rejectsCode(()=>getContributionStatus(e,a.id,opts({receiptToken:b.receiptToken})),'submission_not_found');
  const response=await handleContributionRequest(new Request(`https://hookline.world/api/project-submissions/${a.id}?receiptToken=${a.receiptToken}`),e,opts());
  assert.equal(response.status,400);
  const good=await handleContributionRequest(new Request(`https://hookline.world/api/project-submissions/${a.id}`,{headers:{authorization:`Bearer ${a.receiptToken}`}}),e,opts());
  assert.equal(good.status,200); assert.equal(good.headers.get('cache-control'),'private, no-store');
});
test('Telegram authorization requires exact private user/chat and isolates actors',async()=>{
  const e=env();
  await rejectsCode(()=>submitContribution(e,projectInput,opts({telegramUserId:'123',chatId:'-10077'})),'private_chat_required');
  const result=await submitContribution(e,projectInput,opts({telegramUserId:'123',chatId:'123',requestId:'tg:1'}));
  assert.equal((await listActorSubmissions(e,{telegramUserId:'123',chatId:'123'})).submissions.length,1);
  assert.equal((await listActorSubmissions(e,{telegramUserId:'456',chatId:'456'})).submissions.length,0);
  await rejectsCode(()=>getContributionStatus(e,result.id,opts({telegramUserId:'456',chatId:'456'})),'submission_not_found');
  const duplicate=await submitContribution(e,projectInput,opts({telegramUserId:'123',chatId:'123',requestId:'tg:1'}));
  assert.equal(duplicate.id,result.id); assert.equal(duplicate.alreadySubmitted,true); assert.equal('receiptToken' in duplicate,false);
});
test('atomic per-actor submission cap survives concurrent inserts',async()=>{
  const e=env(); const result=await Promise.allSettled(Array.from({length:24},()=>submitContribution(e,projectInput,opts({actorId:'same'}))));
  assert.equal(result.filter(x=>x.status==='fulfilled').length,12);
  assert.ok(result.filter(x=>x.status==='rejected').every(x=>x.reason.code==='submission_limit'));
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_submissions').first()).n,12);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_contribution_audit').first()).n,12);
  assert.ok(await submitContribution(e,projectInput,opts({actorId:'same',now:NOW+DAY})));
});
test('global daily cap survives parallel distinct actors',async()=>{
  const e=env(); const result=await Promise.allSettled(Array.from({length:260},(_,i)=>submitContribution(e,projectInput,opts({actorId:`actor-${i}`}))));
  assert.equal(result.filter(x=>x.status==='fulfilled').length,250);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM project_submissions').first()).n,250);
});
test('anonymous rate bucket cannot be bypassed with X-Forwarded-For',async()=>{
  const e=env(); const responses=[];
  for (let i=0;i<13;i++) responses.push(await handleContributionRequest(new Request('https://hookline.world/api/project-submissions',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':`203.0.113.${i}`},body:JSON.stringify(projectInput)}),e,opts()));
  assert.equal(responses.filter(r=>r.status===201).length,12); assert.equal(responses.at(-1).status,429);
  const trusted=await handleContributionRequest(new Request('https://hookline.world/api/project-submissions',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.99'},body:JSON.stringify(projectInput)}),e,opts());
  assert.equal(trusted.status,201);
});
test('canonical domain cannot be supplied by claimant or replaced by proof URL',async()=>{
  const e=env();
  await rejectsCode(()=>submitContribution(e,{...claimInput,website:'https://attacker.org'},opts()),'canonical_domain_mismatch');
  await rejectsCode(()=>submitContribution(e,{...claimInput,projectId:'missing'},opts()),'project_not_found');
  const result=await submitContribution(e,{...claimInput,proofUrl:'https://attacker.org/proof'},opts());
  assert.equal(result.verification.name,'_hookline.alpha-hooks.org');
  assert.equal(result.status,'awaiting_proof');
  await rejectsCode(()=>reviewContribution(e,result.id,{decision:'approve',reason:'trust me',proofUrl:'https://attacker.org'},opts({reviewerId:'agent'})),'dns_required');
});
test('DNS missing/wrong nonce/unrelated answer never verifies ownership',async()=>{
  const e=env(); const a=await submitContribution(e,claimInput,opts({actorId:'a'})); const b=await submitContribution(e,claimInput,opts({actorId:'b'}));
  const auth=opts({receiptToken:a.receiptToken});
  await rejectsCode(()=>verifyClaim(e,a.id,{...auth,fetcher:dnsFetch(b.verification.value)}),'dns_proof_missing');
  await rejectsCode(()=>verifyClaim(e,a.id,{...auth,fetcher:dnsFetch(a.verification.value,{name:'_hookline.attacker.org.'})}),'dns_proof_missing');
  await rejectsCode(()=>verifyClaim(e,a.id,{...auth,fetcher:dnsFetch(a.verification.value,{type:5})}),'dns_proof_missing');
  await rejectsCode(()=>verifyClaim(e,a.id,{...auth,fetcher:dnsFetch(a.verification.value,{status:3})}),'dns_proof_missing');
  assert.equal((await getContributionStatus(e,a.id,auth)).status,'awaiting_proof');
});
test('DNS unavailable, oversized, expired, and renewed challenges fail closed',async()=>{
  const e=env(); const result=await submitContribution(e,claimInput,opts()); const auth=opts({receiptToken:result.receiptToken});
  await rejectsCode(()=>verifyClaim(e,result.id,{...auth,fetcher:dnsFetch('',{throwError:true})}),'dns_unavailable');
  await rejectsCode(()=>verifyClaim(e,result.id,{...auth,fetcher:async()=>new Response(' '.repeat(20_000))}),'dns_unavailable');
  await rejectsCode(()=>verifyClaim(e,result.id,{...auth,now:NOW+31*60_000,fetcher:()=>{throw new Error('must not fetch');}}),'challenge_expired');
  const newer=await issueClaimChallenge(e,result.id,auth);
  assert.notEqual(newer.verification.value,result.verification.value);
  await rejectsCode(()=>verifyClaim(e,result.id,{...auth,fetcher:dnsFetch(result.verification.value)}),'dns_proof_missing');
  assert.equal((await verifyClaim(e,result.id,{...auth,fetcher:dnsFetch(newer.verification.value)})).status,'verified_owner');
});
test('valid DNS produces metadata-only ownership and no safety endorsement',async()=>{
  const e=env(); const result=await owner(e); const status=await getContributionStatus(e,result.id,opts({receiptToken:result.receiptToken}));
  assert.equal(status.status,'verified_owner'); assert.equal(status.proof.scope,'project_metadata_only'); assert.equal(status.proof.safetyEndorsement,false);
  const row=await e.DB.prepare('SELECT * FROM project_submissions WHERE id=?').bind(result.id).first();
  assert.equal(row.challenge_hash,null); assert.equal(JSON.stringify(row).includes(result.verification.value),false);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM project_contribution_audit WHERE action='ownership_verified'").first()).n,1);
});
test('a second proof cannot silently replace an active owner',async()=>{
  const e=env(); const a=await owner(e); const b=await submitContribution(e,claimInput,opts({actorId:'other'}));
  await rejectsCode(()=>verifyClaim(e,b.id,opts({receiptToken:b.receiptToken,fetcher:dnsFetch(b.verification.value)})),'ownership_conflict');
  assert.equal((await e.DB.prepare('SELECT submission_id FROM project_owners WHERE project_id=?').bind('alpha').first()).submission_id,a.id);
});
test('an expired owner does not permanently lock a researched project',async()=>{
  const e=env(); const a=await owner(e); const later=NOW+91*DAY;
  const b=await submitContribution(e,claimInput,opts({actorId:'replacement',now:later}));
  const result=await verifyClaim(e,b.id,opts({receiptToken:b.receiptToken,now:later,fetcher:dnsFetch(b.verification.value)}));
  assert.equal(result.status,'verified_owner');
  assert.equal((await e.DB.prepare('SELECT submission_id FROM project_owners WHERE project_id=?').bind('alpha').first()).submission_id,b.id);
  await rejectsCode(()=>getContributionStatus(e,a.id,opts({receiptToken:a.receiptToken,now:later})),'receipt_expired');
});
test('generated IDs fit Telegram routing and unresearched domains cannot be claimed',async()=>{
  const e=env(); const added=await submitContribution(e,{...projectInput,name:'A'.repeat(100)},opts());
  assert.ok(added.projectId.length<=48);
  await rejectsCode(()=>submitContribution(e,claimInput,opts({getProject:async()=>({...projects.alpha,provenance:'community-submitted'})})),'domain_verification_unavailable');
  await rejectsCode(()=>submitContribution(e,claimInput,opts({getProject:async()=>({...projects.alpha,website:'https://t.co/a'})})),'domain_verification_unavailable');
});
test('owner updates only safe metadata and produce immutable audit revisions',async()=>{
  const e=env(); const result=await owner(e); const auth=opts({receiptToken:result.receiptToken});
  const updated=await updateClaimedMetadata(e,result.id,{name:'Alpha hooks',description:'Updated project description.',website:'https://www.alpha-hooks.org/about',agreement:true},auth);
  assert.equal(updated.status,'approved'); assert.equal(updated.metadataRevision,1);
  const next=await updateClaimedMetadata(e,result.id,{description:'A second revision.',agreement:true},auth);
  assert.equal(next.metadataRevision,2);
  const metadata=(await readProjectOverrides(e)).alpha;
  assert.equal(metadata.name,'Alpha hooks'); assert.equal(metadata.summary,'A second revision.');
  assert.equal(metadata.metadataProvenance,'domain-verified');
  for (const key of ['contact','payload','actor_key','telegram_user_id','contracts','fees','observations','owner']) assert.equal(key in metadata,false);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM project_contribution_audit WHERE action='metadata_updated'").first()).n,2);
  assert.equal((await readContributionAudit(e,'alpha')).revisions.filter(r=>r.action==='metadata_updated').length,2);
});
test('unverified users and owners cannot edit chain data, other projects, or canonical domains',async()=>{
  const e=env(); const pending=await submitContribution(e,claimInput,opts());
  await rejectsCode(()=>updateClaimedMetadata(e,pending.id,{description:'new',agreement:true},opts({receiptToken:pending.receiptToken})),'ownership_required');
  const result=await owner(e,{actorId:'owner'}); const auth=opts({receiptToken:result.receiptToken});
  for (const input of [{fees:0,agreement:true},{projectId:'beta',name:'fake',agreement:true},{contracts:[],agreement:true},{observations:[],agreement:true}]) await rejectsCode(()=>updateClaimedMetadata(e,result.id,input,auth),'unknown_field');
  await rejectsCode(()=>updateClaimedMetadata(e,result.id,{website:'https://attacker.org',agreement:true},auth),'domain_change_requires_review');
  await rejectsCode(()=>updateClaimedMetadata(e,result.id,{name:'Renamed',agreement:true},{...auth,now:NOW+31*DAY}),'ownership_proof_expired');
});
test('verified owner renewal and capability revocation work without email',async()=>{
  const e=env(); const a=await owner(e); const auth=opts({receiptToken:a.receiptToken,now:NOW+31*DAY});
  const renewed=await issueClaimChallenge(e,a.id,auth);
  await verifyClaim(e,a.id,{...auth,fetcher:dnsFetch(renewed.verification.value)});
  assert.equal((await updateClaimedMetadata(e,a.id,{name:'Renewed Alpha',agreement:true},auth)).status,'approved');
  await revokeContribution(e,a.id,auth);
  await rejectsCode(()=>updateClaimedMetadata(e,a.id,{name:'Invalid',agreement:true},auth),'receipt_revoked');
  assert.equal((await readProjectOverrides(e)).alpha.name,'Renewed Alpha');
  const b=await submitContribution(e,claimInput,opts({actorId:'new-controller',now:NOW+31*DAY}));
  assert.equal((await verifyClaim(e,b.id,opts({receiptToken:b.receiptToken,fetcher:dnsFetch(b.verification.value),now:NOW+31*DAY}))).status,'verified_owner');
});
test('receipt expires and changed canonical domain invalidates old claims',async()=>{
  const e=env(); const a=await submitContribution(e,claimInput,opts());
  await rejectsCode(()=>getContributionStatus(e,a.id,opts({receiptToken:a.receiptToken,now:NOW+91*DAY})),'receipt_expired');
  const changed=async()=>({id:'alpha',website:'https://different-domain.org/'});
  await rejectsCode(()=>issueClaimChallenge(e,a.id,opts({receiptToken:a.receiptToken,getProject:changed})),'canonical_domain_changed');
  await rejectsCode(()=>verifyClaim(e,a.id,opts({receiptToken:a.receiptToken,getProject:changed,fetcher:()=>{throw Error('must not fetch');}})),'canonical_domain_changed');
});
test('trusted review publishes source-backed metadata, never supplied affiliations',async()=>{
  const e=env(); const submitted=await submitContribution(e,{...projectInput,contracts:[{chainId:1,address:'0x'+'a'.repeat(40),role:'hook'}],contact:'@project_team'},opts());
  assert.equal((await listReviewQueue(e)).submissions.length,1);
  const result=await reviewContribution(e,submitted.id,{decision:'approve',reason:'Checked published project identity and description. Contracts need separate affiliation research.',proofUrl:'https://useful-hooks.org/about'},opts({reviewerId:'agent-review-1'}));
  assert.equal(result.status,'approved');
  const metadata=(await readProjectOverrides(e))[submitted.projectId];
  assert.equal(metadata.name,'Useful Hooks'); assert.equal(metadata.metadataProvenance,'community-reviewed'); assert.equal('contracts' in metadata,false);
  assert.equal((await listReviewQueue(e)).submissions.length,0);
  await rejectsCode(()=>reviewContribution(e,submitted.id,{decision:'reject',reason:'late decision'},opts({reviewerId:'agent-review-2'})),'review_conflict');
});
test('review requires evidence, rejects privilege fields and unsafe domain migrations',async()=>{
  const e=env(); const submitted=await submitContribution(e,{kind:'correction',projectId:'alpha',message:'Change project URL',website:'https://new-alpha.org/',agreement:true},opts());
  const auth=opts({reviewerId:'agent'});
  await rejectsCode(()=>reviewContribution(e,submitted.id,{decision:'approve',reason:'looks fine'},auth),'invalid_field');
  await rejectsCode(()=>reviewContribution(e,submitted.id,{decision:'approve',reason:'looks fine',proofUrl:'https://new-alpha.org/',metadata:{fees:0}},auth),'unknown_field');
  await rejectsCode(()=>reviewContribution(e,submitted.id,{decision:'approve',reason:'looks fine',proofUrl:'https://new-alpha.org/'},auth),'domain_change_proof_required');
  const result=await reviewContribution(e,submitted.id,{decision:'approve',reason:'Verified the migration announcement on the original domain.',proofUrl:'https://alpha-hooks.org/migration'},auth);
  assert.equal(result.status,'approved');
});
test('simultaneous reviews cannot overwrite the winning decision or double its revision',async()=>{
  const e=env(); const submitted=await submitContribution(e,projectInput,opts());
  const outcomes=await Promise.allSettled(['First','Second'].map(name=>reviewContribution(e,submitted.id,{decision:'approve',reason:'Checked source',proofUrl:'https://useful-hooks.org/',metadata:{name,description:'Description',website:'https://useful-hooks.org/'}},opts({reviewerId:name}))));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await readProjectOverrides(e))[submitted.projectId].metadataRevision,1);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM project_contribution_audit WHERE action='review_approved'").first()).n,1);
});
test('review API is secret-gated; creation rejects oversized and cross-origin requests',async()=>{
  const e=env(); const base='https://hookline.world/api/project-submissions';
  assert.equal((await handleContributionRequest(new Request(`${base}/review-queue`),e,opts())).status,503);
  e.PROJECT_REVIEW_TOKEN='r'.repeat(40);
  assert.equal((await handleContributionRequest(new Request(`${base}/review-queue`),e,opts())).status,403);
  assert.equal((await handleContributionRequest(new Request(`${base}/review-queue`,{headers:{authorization:`Bearer ${e.PROJECT_REVIEW_TOKEN}`}}),e,opts())).status,200);
  assert.equal((await handleContributionRequest(new Request(base,{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.org'},body:JSON.stringify(projectInput)}),e,opts())).status,403);
  assert.equal((await handleContributionRequest(new Request(base,{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(20_000)}),e,opts())).status,413);
  assert.equal((await handleContributionRequest(new Request(base,{method:'POST',body:JSON.stringify(projectInput)}),e,opts())).status,415);
});
test('challenge issuance rate is bounded and queue excludes unproved claims',async()=>{
  const e=env(); const submitted=await submitContribution(e,claimInput,opts());
  assert.equal((await listReviewQueue(e)).submissions.length,0);
  for(let i=0;i<6;i++) await issueClaimChallenge(e,submitted.id,opts({receiptToken:submitted.receiptToken}));
  await rejectsCode(()=>issueClaimChallenge(e,submitted.id,opts({receiptToken:submitted.receiptToken})),'verification_limit');
});
let passed=0;
for (const [name,fn] of tests) { try { await fn(); passed++; console.log(`PASS ${name}`); } catch(error) { console.error(`FAIL ${name}`); throw error; } }
console.log(`\n${passed} project-contribution tests passed.`);
