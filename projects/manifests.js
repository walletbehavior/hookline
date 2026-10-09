/**
 * Private, review-gated project-manifest intake.
 *
 * A manifest is an unverified claim. This module deliberately has no import
 * from the public registry or scanner: accepting (or approving) a claim never
 * adds a project, verifies a deployment, or enables monitoring.
 */
const MAX_BODY = 16_384;
const DAY = 86_400_000;
const RECEIPT_TTL = 30 * DAY;
const MANIFEST_MAX_LIFETIME = 31 * DAY;
const ACTOR_LIMIT = 8;
const GLOBAL_LIMIT = 200;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const ROLES = new Set(['token','factory','registry','hook','vault','controller','implementation','program','other']);
const ROOT_KEYS = new Set(['schemaVersion','projectId','name','summary','website','sources','deployments','issuedAt','expiresAt']);
const SOURCE_KEYS = new Set(['label','url']);
const DEPLOYMENT_KEYS = new Set(['chain','chainId','address','role','sourceUrl']);
const REVIEW_KEYS = new Set(['decision','reason','evidenceUrl']);

export class ManifestError extends Error { constructor(status,code,message) { super(message); this.status=status; this.code=code; } }
const fail=(status,code,message)=>{ throw new ManifestError(status,code,message); };
const db=env=>{ if(!env?.DB?.prepare || !env.DB.batch) fail(503,'storage_unavailable','Manifest intake is temporarily unavailable.'); return env.DB; };
const changes=result=>Number(result?.meta?.changes ?? result?.changes ?? 0);
function plainObject(value,keys) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) fail(422,'invalid_body','A JSON object is required.');
  for(const key of Object.keys(value)) if(!keys.has(key)) fail(422,'unknown_field',`Unsupported field: ${key.slice(0,40)}.`);
}
function text(value,field,max,required=true) {
  if(value == null && !required) return '';
  if(typeof value!=='string') fail(422,'invalid_field',`${field} must be text.`);
  const clean=value.trim();
  if(!clean || clean.length>max || /[\u0000-\u001F\u007F<>]/.test(clean)) fail(422,'invalid_field',`${field} is invalid or too long.`);
  return clean;
}
function https(value,field) {
  const raw=text(value,field,2048); let url;
  try { url=new URL(raw); } catch { fail(422,'invalid_url',`${field} must be a public HTTPS URL.`); }
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || !host.includes('.') || host.length>253 || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(x=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|lan|home|arpa)$/.test(host)) fail(422,'invalid_url',`${field} must be a public HTTPS URL.`);
  return url.href;
}
function timestamp(value,field) {
  if(typeof value!=='string' || value.length>40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(422,'invalid_timestamp',`${field} must be an ISO-8601 UTC timestamp.`);
  const ms=Date.parse(value); if(!Number.isFinite(ms) || new Date(ms).toISOString()!==value) fail(422,'invalid_timestamp',`${field} must be an ISO-8601 UTC timestamp.`);
  return ms;
}
function source(item) { plainObject(item,SOURCE_KEYS); return {label:text(item.label,'source.label',120),url:https(item.url,'source.url')}; }
function deployment(item) {
  plainObject(item,DEPLOYMENT_KEYS);
  const chain=text(item.chain,'deployment.chain',12).toLowerCase();
  const role=text(item.role,'deployment.role',32).toLowerCase();
  if(!['evm','solana'].includes(chain) || !ROLES.has(role)) fail(422,'invalid_deployment','Unsupported deployment chain or role.');
  if(chain==='evm') {
    if(!Number.isSafeInteger(item.chainId) || item.chainId<1 || item.chainId>999999999 || !EVM.test(String(item.address || '')) || role==='program') fail(422,'invalid_deployment','An EVM deployment needs a chain ID, EVM address, and compatible role.');
    return {chain,chainId:item.chainId,address:item.address.toLowerCase(),role,sourceUrl:https(item.sourceUrl,'deployment.sourceUrl')};
  }
  if(Object.hasOwn(item,'chainId') || !SOLANA.test(String(item.address || '')) || role==='hook' || role==='implementation') fail(422,'invalid_deployment','A Solana deployment needs a base58 address and compatible role.');
  return {chain,address:item.address,role,sourceUrl:https(item.sourceUrl,'deployment.sourceUrl')};
}
export function validateManifest(input,{now=Date.now()}={}) {
  plainObject(input,ROOT_KEYS);
  if(input.schemaVersion!==1) fail(422,'unsupported_schema','Only manifest schemaVersion 1 is supported.');
  const issuedAt=timestamp(input.issuedAt,'issuedAt'), expiresAt=timestamp(input.expiresAt,'expiresAt');
  if(expiresAt<=issuedAt || expiresAt-issuedAt>MANIFEST_MAX_LIFETIME || expiresAt<=now || issuedAt>now+DAY || issuedAt<now-7*DAY) fail(422,'invalid_expiry','Manifest timestamps are outside the allowed review window.');
  const projectId=text(input.projectId,'projectId',64).toLowerCase(); if(!SLUG.test(projectId)) fail(422,'invalid_project','projectId must be a lowercase slug.');
  const sources=Array.isArray(input.sources) ? input.sources : null;
  const deployments=Array.isArray(input.deployments) ? input.deployments : null;
  if(!sources || sources.length<1 || sources.length>8 || !deployments || deployments.length>16) fail(422,'invalid_manifest','Use 1–8 sources and at most 16 deployments.');
  const normalized={schemaVersion:1,projectId,name:text(input.name,'name',100),summary:text(input.summary,'summary',1200),website:https(input.website,'website'),sources:sources.map(source),deployments:deployments.map(deployment),issuedAt:new Date(issuedAt).toISOString(),expiresAt:new Date(expiresAt).toISOString()};
  const seen=new Set();
  for(const item of normalized.deployments) { const key=`${item.chain}:${item.chainId ?? 'mainnet'}:${item.address}:${item.role}`; if(seen.has(key)) fail(422,'duplicate_deployment','Each deployment may be claimed once per role.'); seen.add(key); }
  if(JSON.stringify(normalized).length>MAX_BODY) fail(413,'body_too_large','Manifest is too large.');
  return normalized;
}
async function sha(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join(''); }
function token() { const b=crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function id() { return crypto.randomUUID(); }
function json(value,status=200) { return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','vary':'Authorization'}}); }
function bearer(request) { const value=request.headers.get('authorization') || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
function actor(request) { const ip=request.headers.get('cf-connecting-ip'); return ip && /^[0-9a-fA-F:.]{3,64}$/.test(ip) ? `ip:${ip}` : 'public:shared'; }
async function authorizeRow(env,id,receipt,now) {
  if(!CAPABILITY.test(receipt)) fail(404,'manifest_not_found','Manifest not found.');
  const row=await db(env).prepare('SELECT * FROM project_manifest_submissions WHERE id=? AND capability_hash=?').bind(id,await sha(receipt)).first();
  if(!row || row.receipt_expires_at<=now || row.status==='revoked') fail(404,'manifest_not_found','Manifest not found.');
  return row;
}
async function consumeLimit(database,key,limit,now) {
  const result=await database.prepare(`INSERT INTO project_manifest_limits(bucket_key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET hits=CASE WHEN project_manifest_limits.expires_at<=excluded.expires_at-? THEN 1 ELSE project_manifest_limits.hits+1 END, expires_at=excluded.expires_at WHERE project_manifest_limits.hits<? OR project_manifest_limits.expires_at<=excluded.expires_at-?`).bind(key,now+DAY,DAY,limit,DAY).run();
  return changes(result)>0;
}
export async function submitManifest(env,input,{now=Date.now(),actorId='public:shared'}={}) {
  const database=db(env), manifest=validateManifest(input,{now}); const payload=JSON.stringify(manifest); const manifestHash=await sha(payload), actorKey=await sha(`manifest:${actorId}`);
  const existing=await database.prepare('SELECT id FROM project_manifest_submissions WHERE manifest_hash=?').bind(manifestHash).first();
  if(existing) fail(409,'duplicate_manifest','This exact manifest is already awaiting review.');
  if(!await consumeLimit(database,`actor:${actorKey}`,ACTOR_LIMIT,now) || !await consumeLimit(database,'global',GLOBAL_LIMIT,now)) fail(429,'submission_limit','Manifest submission limit reached. Try again later.');
  const receipt=token(), submissionId=id(), receiptExpiresAt=now+RECEIPT_TTL;
  try { await database.batch([
    database.prepare('INSERT INTO project_manifest_submissions(id,project_id,actor_key,manifest_json,manifest_hash,capability_hash,receipt_expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(submissionId,manifest.projectId,actorKey,payload,manifestHash,await sha(receipt),receiptExpiresAt,'pending_review',now,now),
    database.prepare('INSERT INTO project_manifest_audit(id,submission_id,project_id,action,reviewer_id,reason_code,reason_detail,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(),submissionId,manifest.projectId,'submitted','system','submitted','Private manifest received.','{}',now),
  ]); } catch(error) { if(String(error?.message || '').includes('UNIQUE')) fail(409,'duplicate_manifest','This exact manifest is already awaiting review.'); throw error; }
  return {id:submissionId,status:'pending_review',receiptToken:receipt,receiptExpiresAt:new Date(receiptExpiresAt).toISOString(),reviewScope:'Claim only. It is not public registry data, verified deployment data, or monitoring authorization.'};
}
function privateStatus(row) { return {id:row.id,projectId:row.project_id,status:row.status,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),receiptExpiresAt:new Date(row.receipt_expires_at).toISOString(),reviewScope:'Manifest claims remain separate from the public registry, verification, and monitoring.'}; }
export async function getManifestStatus(env,idValue,{receiptToken,now=Date.now()}={}) { return privateStatus(await authorizeRow(env,idValue,receiptToken,now)); }
async function requireReviewer(request,env) { const configured=env?.PROJECT_MANIFEST_REVIEW_TOKEN; if(typeof configured!=='string' || configured.length<32) fail(503,'review_agent_unconfigured','Manifest review is not configured.'); const supplied=bearer(request); if(!supplied || await sha(supplied)!==await sha(configured)) fail(403,'review_access_denied','Review access denied.'); }
export async function listManifestReviewQueue(env,{now=Date.now()}={}) { const results=await db(env).prepare("SELECT id,project_id,manifest_json,created_at,updated_at FROM project_manifest_submissions WHERE status='pending_review' AND json_extract(manifest_json,'$.expiresAt')>? ORDER BY created_at ASC LIMIT 50").bind(new Date(now).toISOString()).all(); return {submissions:(results.results || []).map(row=>({id:row.id,projectId:row.project_id,manifest:JSON.parse(row.manifest_json),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()}))}; }
export async function reviewManifest(env,idValue,input,{reviewerId='authenticated-manifest-reviewer',now=Date.now()}={}) {
  plainObject(input,REVIEW_KEYS); const decision=text(input.decision,'decision',12).toLowerCase(); if(!['approve','reject'].includes(decision)) fail(422,'invalid_decision','Use approve or reject.');
  const reason=text(input.reason,'reason',800), evidenceUrl=https(input.evidenceUrl,'evidenceUrl'); const database=db(env);
  const row=await database.prepare("SELECT * FROM project_manifest_submissions WHERE id=? AND status='pending_review'").bind(idValue).first(); if(!row) fail(409,'review_conflict','Manifest is no longer awaiting review.');
  const manifest=JSON.parse(row.manifest_json); if(Date.parse(manifest.expiresAt)<=now) fail(409,'manifest_expired','Manifest expired before review.');
  // Approval records a review result only. It cannot publish, verify, or monitor.
  const result=await database.batch([
    database.prepare("UPDATE project_manifest_submissions SET status=?,updated_at=?,reviewed_at=?,reviewer_id=? WHERE id=? AND status='pending_review'").bind(decision==='approve'?'reviewed':'rejected',now,now,reviewerId,idValue),
    database.prepare('INSERT INTO project_manifest_audit(id,submission_id,project_id,action,reviewer_id,reason_code,reason_detail,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(),idValue,row.project_id,decision==='approve'?'reviewed':'rejected',reviewerId,decision,reason,JSON.stringify({evidenceUrl}),now),
  ]); if(!changes(result[0])) fail(409,'review_conflict','Another review changed this manifest.');
  return {id:idValue,projectId:row.project_id,status:decision==='approve'?'reviewed':'rejected',reviewScope:'Review records an unverified claim only. A separate evidence workflow is required before any public, verified, or monitored use.'};
}
async function boundedJson(request) { const length=Number(request.headers.get('content-length')); if(Number.isFinite(length) && length>MAX_BODY) fail(413,'body_too_large','Manifest is too large.'); const raw=await request.text(); if(raw.length>MAX_BODY) fail(413,'body_too_large','Manifest is too large.'); try{return JSON.parse(raw);}catch{fail(400,'invalid_json','Invalid JSON.');} }
export async function handleManifestRequest(request,env,options={}) {
  const url=new URL(request.url), prefix='/api/project-manifests'; if(url.pathname!==prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  try {
    if([...url.searchParams.keys()].some(key=>/token|secret|receipt|key|capability/i.test(key))) fail(400,'credentials_in_url','Send credentials only in the Authorization header.');
    if(!['GET','POST'].includes(request.method)) return json({error:{code:'method_not_allowed',message:'Use GET or POST.'}},405);
    if(url.pathname===`${prefix}/review-queue` && request.method==='GET') { await requireReviewer(request,env); return json(await listManifestReviewQueue(env,options)); }
    if(url.pathname===prefix && request.method==='POST') { if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415,'json_required','Send application/json.'); return json(await submitManifest(env,await boundedJson(request),{...options,actorId:actor(request)}),201); }
    const match=url.pathname.match(/^\/api\/project-manifests\/([a-f0-9-]{36})(?:\/(review))?$/); if(!match) return json({error:{code:'not_found',message:'Endpoint not found.'}},404);
    if(match[2]==='review' && request.method==='POST') { await requireReviewer(request,env); return json(await reviewManifest(env,match[1],await boundedJson(request),{...options,reviewerId:'authenticated-manifest-reviewer'})); }
    if(!match[2] && request.method==='GET') return json(await getManifestStatus(env,match[1],{...options,receiptToken:bearer(request)}));
    return json({error:{code:'method_not_allowed',message:'Use the documented method.'}},405);
  } catch(error) { if(error instanceof ManifestError) return json({error:{code:error.code,message:error.message}},error.status); return json({error:{code:'manifests_unavailable',message:'Manifest intake is temporarily unavailable. Please retry later.'}},503); }
}
