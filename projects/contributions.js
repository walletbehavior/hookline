/** Private, API-first project contributions. No email, wallet signing, or paid gate. */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CHALLENGE_TTL = 30 * 60_000;
const RECEIPT_TTL = 90 * DAY;
const PROOF_TTL = 30 * DAY;
const MAX_BODY = 16_384;
const MAX_ACTOR_DAILY = 12;
const MAX_GLOBAL_DAILY = 250;
const DNS_RESOLVER = 'https://cloudflare-dns.com/dns-query';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const SHARED_DOMAINS = new Set(['github.com', 'gitlab.com', 'x.com', 'twitter.com', 't.co', 't.me', 'telegram.me', 'medium.com', 'linktr.ee', 'notion.so', 'docs.google.com']);
const FIELDS = new Set(['kind', 'projectId', 'name', 'website', 'description', 'contracts', 'contact', 'proofUrl', 'message', 'agreement', 'websiteTrap']);
const META_FIELDS = new Set(['name', 'description', 'website', 'agreement']);

export class ContributionError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ContributionError'; this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new ContributionError(status, code, message); }
function db(env) { if (!env?.DB?.prepare || !env.DB.batch) fail(503, 'storage_unavailable', 'Project submissions are temporarily unavailable.'); return env.DB; }
function changes(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }
function nowOf(options) { return Number.isFinite(options?.now) ? Math.trunc(options.now) : Date.now(); }
function text(value, field, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') fail(422, 'invalid_field', `${field} must be text.`);
  const clean = value.trim();
  if (clean.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/.test(clean) || (required && !clean)) fail(422, 'invalid_field', `${field} is invalid or too long.`);
  return clean;
}
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(422, 'invalid_body', 'A JSON object is required.');
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(422, 'unknown_field', `Unsupported field: ${key.slice(0,40)}.`);
}
export function validatePublicHostname(input) {
  const host = String(input || '').toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.split('.').some(x => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) fail(422, 'invalid_domain', 'A public project domain is required.');
  const labels = host.split('.');
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || ['localhost','local','internal','test','invalid','example','onion','lan','home','arpa'].includes(labels.at(-1)) || host.endsWith('.localhost')) fail(422, 'invalid_domain', 'A public project domain is required.');
  return host;
}
function publicUrl(value, field, required = false) {
  const candidate = text(value, field, 2048, required);
  if (!candidate) return '';
  let url;
  try { url = new URL(candidate); } catch { fail(422, 'invalid_url', `${field} must be a public HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) fail(422, 'invalid_url', `${field} must be a public HTTPS URL.`);
  validatePublicHostname(url.hostname);
  return url.href;
}
function domainOf(url) { return validatePublicHostname(new URL(url).hostname).replace(/^www\./, ''); }
function normalizeContracts(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return text(value, 'contracts', 3000);
  if (!Array.isArray(value) || value.length > 16) fail(422, 'invalid_contracts', 'Use at most 16 proposed contracts.');
  return value.map(item => {
    object(item, new Set(['chainId','address','role']));
    if (!Number.isSafeInteger(item.chainId) || item.chainId < 1 || typeof item.address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(item.address)) fail(422, 'invalid_contracts', 'Each proposed contract needs a chain ID and EVM address.');
    const role = text(item.role, 'role', 32) || 'other';
    if (!['hook','token','factory','implementation','other'].includes(role)) fail(422, 'invalid_contracts', 'Unsupported contract role.');
    return {chainId:item.chainId,address:item.address.toLowerCase(),role};
  });
}
export function validateContribution(input) {
  object(input, FIELDS);
  if (input.websiteTrap != null && input.websiteTrap !== '') fail(422, 'invalid_submission', 'Invalid submission.');
  if (input.agreement !== true) fail(422, 'agreement_required', 'Confirm that your submission is accurate and can be reviewed.');
  if (!['project','claim','correction'].includes(input.kind)) fail(422, 'invalid_kind', 'Choose project, claim, or correction.');
  const projectId = text(input.projectId, 'projectId', 64);
  if ((projectId && !SLUG.test(projectId)) || (input.kind !== 'project' && !projectId)) fail(422, 'invalid_project', 'An existing project ID is required.');
  const result = {
    kind:input.kind, projectId, name:text(input.name,'name',100,input.kind === 'project'),
    website:publicUrl(input.website,'website',input.kind === 'project'),
    description:text(input.description,'description',1200,input.kind === 'project'),
    contracts:normalizeContracts(input.contracts), contact:text(input.contact,'contact',33),
    proofUrl:publicUrl(input.proofUrl,'proofUrl'), message:text(input.message,'message',2000,input.kind === 'correction'), agreement:true,
  };
  if (result.name.includes('\n') || result.name.includes('\r')) fail(422,'invalid_field','name must be one line.');
  if (result.contact && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(result.contact)) fail(422, 'invalid_contact', 'Contact is optional. Use a Telegram @handle, not an email address.');
  if (JSON.stringify(result).length > MAX_BODY) fail(413,'body_too_large','Submission is too large.');
  return result;
}
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2,'0')).join(''); }
function secret() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function telegramIdentity(options) {
  if (options?.telegramUserId == null && options?.chatId == null) return null;
  const user = String(options?.telegramUserId || ''); const chat = String(options?.chatId || '');
  if (!ID.test(user) || chat !== user) fail(403, 'private_chat_required', 'Use a private conversation with the Hookline bot for project submissions.');
  return {user,chat};
}
async function actorKey(options) {
  const tg = telegramIdentity(options);
  if (tg) return {key:await hash(`telegram:${tg.user}`),tg};
  const actor = options?.actorId == null ? 'public:shared' : text(options.actorId,'actorId',256,true);
  return {key:await hash(`actor:${actor}`),tg:null};
}
async function canonicalProject(id, options) {
  if (typeof options?.getProject !== 'function') fail(503,'registry_unavailable','The project registry is temporarily unavailable.');
  const found = await options.getProject(id);
  const project = found?.project || found;
  if (!project || project.id !== id) fail(404,'project_not_found','Project not found.');
  return project;
}
function canonicalDomain(project) {
  if (/^(?:community|submitted|unverified)/i.test(String(project.provenance || ''))) fail(422,'domain_verification_unavailable','This project needs a researched canonical domain before it can be claimed.');
  const url = publicUrl(project.website,'canonical website',true);
  const domain = domainOf(url);
  if (SHARED_DOMAINS.has(domain)) fail(422,'domain_verification_unavailable','This project needs its own researched domain before it can be claimed.');
  return domain;
}
function challenge(id, projectId, domain, now) {
  const value = `hookline-verification=${projectId}:${id}:${secret()}`;
  return {method:'dns_txt',name:`_hookline.${domain}`,value,expiresAt:new Date(now + CHALLENGE_TTL).toISOString(),domain};
}
function privateStatus(row) {
  return {id:row.id,kind:row.kind,projectId:row.project_id,status:row.status,
    reason:{code:row.reason_code,message:row.reason_detail},createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),
    receiptExpiresAt:new Date(row.capability_expires_at).toISOString(),
    ...(row.proof_json ? {proof:JSON.parse(row.proof_json)} : {}),
    ...(row.kind === 'claim' ? {verification:{method:'dns_txt',name:`_hookline.${row.canonical_domain}`,expiresAt:row.challenge_expires_at ? new Date(row.challenge_expires_at).toISOString() : null}} : {})};
}
function reasonFor(kind) { return kind === 'claim' ? ['dns_proof_required','Publish the supplied DNS TXT record on the project’s researched domain, then verify it.'] : ['awaiting_agent_review','Saved for evidence-based review. Submission does not establish affiliation or endorse safety.']; }

/** Trusted callers may pass a Telegram identity; HTTP callers never control actorId. */
export async function submitContribution(env, input, options = {}) {
  const database = db(env); const payload = validateContribution(input); const now = nowOf(options);
  const actor = await actorKey(options);
  let canonical = null;
  if (payload.kind !== 'project') canonical = await canonicalProject(payload.projectId, options);
  else if (payload.projectId && typeof options.getProject === 'function' && await options.getProject(payload.projectId)) fail(409,'project_exists','This project already exists. Submit a correction instead.');
  const requestId = options.requestId == null ? null : text(options.requestId,'requestId',128,true);
  if (requestId && !/^[A-Za-z0-9:_-]+$/.test(requestId)) fail(422,'invalid_request_id','Invalid request ID.');
  if (requestId) {
    const duplicate = await database.prepare('SELECT * FROM project_submissions WHERE actor_key = ? AND request_id = ?').bind(actor.key,requestId).first();
    if (duplicate) return {...privateStatus(duplicate),alreadySubmitted:true,message:'Already saved. Use your original receipt or the private bot to check its status.'};
  }
  const id = crypto.randomUUID();
  if (!payload.projectId) payload.projectId = `${payload.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,39).replace(/-$/,'') || 'project'}-${id.slice(0,8)}`;
  const receiptToken = secret(); const receiptHash = await hash(receiptToken);
  const domain = payload.kind === 'claim' ? canonicalDomain(canonical) : null;
  // A claimant cannot substitute their own website for the researched domain.
  if (domain && payload.website && domainOf(payload.website) !== domain) fail(422,'canonical_domain_mismatch','Claims must verify the project’s existing researched domain.');
  const dns = domain ? challenge(id,payload.projectId,domain,now) : null;
  const [reasonCode,reasonDetail] = reasonFor(payload.kind);
  const status = domain ? 'awaiting_proof' : 'pending_review';
  const dayStart = Math.floor(now / DAY) * DAY;
  const insert = database.prepare(`INSERT INTO project_submissions
    (id,kind,project_id,actor_key,telegram_user_id,chat_id,request_id,payload_json,capability_hash,capability_expires_at,status,reason_code,reason_detail,canonical_domain,challenge_hash,challenge_expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM project_submissions WHERE actor_key = ? AND created_at >= ?) < ? AND
      (SELECT COUNT(*) FROM project_submissions WHERE created_at >= ?) < ?
    ON CONFLICT(actor_key,request_id) WHERE request_id IS NOT NULL DO NOTHING`).bind(
    id,payload.kind,payload.projectId,actor.key,actor.tg?.user || null,actor.tg?.chat || null,requestId,JSON.stringify(payload),receiptHash,now+RECEIPT_TTL,status,reasonCode,reasonDetail,domain,dns ? await hash(dns.value) : null,dns ? now+CHALLENGE_TTL : null,now,now,actor.key,dayStart,MAX_ACTOR_DAILY,dayStart,MAX_GLOBAL_DAILY);
  const audit = database.prepare(`INSERT INTO project_contribution_audit (id,submission_id,project_id,action,reviewer_id,reason_code,reason_detail,evidence_json,created_at)
    SELECT ?,id,project_id,'submitted','submission-api',reason_code,reason_detail,'{}',? FROM project_submissions WHERE id = ?`).bind(crypto.randomUUID(),now,id);
  const results = await database.batch([insert,audit]);
  if (!changes(results[0])) fail(429,'submission_limit','The submission limit has been reached. Try again tomorrow.');
  return {id,kind:payload.kind,projectId:payload.projectId,status,receiptToken,receiptExpiresAt:new Date(now+RECEIPT_TTL).toISOString(),message:reasonDetail,...(dns ? {verification:dns} : {})};
}

async function authenticatedSubmission(env,id,options = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) fail(404,'submission_not_found','Submission not found.');
  const row = await db(env).prepare('SELECT * FROM project_submissions WHERE id = ?').bind(id).first();
  if (!row) fail(404,'submission_not_found','Submission not found.');
  const tg = telegramIdentity(options);
  let valid = tg && row.telegram_user_id === tg.user && row.chat_id === tg.chat;
  if (!valid && typeof options.receiptToken === 'string' && CAPABILITY.test(options.receiptToken)) valid = await hash(options.receiptToken) === row.capability_hash;
  if (!valid) fail(404,'submission_not_found','Submission not found.');
  if (row.revoked_at || row.status === 'revoked') fail(403,'receipt_revoked','This project receipt has been revoked.');
  if (row.capability_expires_at <= nowOf(options)) fail(403,'receipt_expired','This project receipt has expired.');
  return row;
}
export async function getContributionStatus(env,id,options = {}) { return privateStatus(await authenticatedSubmission(env,id,options)); }
export async function listActorSubmissions(env,options = {}) {
  const tg = telegramIdentity(options);
  if (!tg) fail(403,'private_chat_required','Use a private conversation with the Hookline bot.');
  const limit = Math.max(1,Math.min(30,Number(options.limit) || 10));
  const rows = await db(env).prepare('SELECT * FROM project_submissions WHERE telegram_user_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?').bind(tg.user,tg.chat,limit).all();
  return {submissions:rows.results.map(privateStatus)};
}
async function reserveLimit(env,key,now,window,max) {
  const bucket = Math.floor(now/window); const until = (bucket+1)*window;
  const result = await db(env).prepare(`INSERT INTO project_contribution_limits(bucket_key,hits,expires_at) VALUES (?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits`).bind(`${key}:${bucket}`,until,max).first();
  if (!result) fail(429,'verification_limit','The verification limit has been reached. Try again later.');
}
export async function issueClaimChallenge(env,id,options = {}) {
  const row = await authenticatedSubmission(env,id,options); const now = nowOf(options);
  if (row.kind !== 'claim' || !['awaiting_proof','verified_owner'].includes(row.status)) fail(409,'not_claimable','This request cannot receive an ownership challenge.');
  const domain = canonicalDomain(await canonicalProject(row.project_id,options));
  if (domain !== row.canonical_domain) fail(409,'canonical_domain_changed','The researched domain changed. Submit a new claim for review.');
  await reserveLimit(env,`challenge:${row.actor_key}`,now,HOUR,6);
  const dns = challenge(row.id,row.project_id,domain,now);
  await db(env).prepare('UPDATE project_submissions SET challenge_hash = ?,challenge_expires_at = ?,updated_at = ? WHERE id = ? AND revoked_at IS NULL').bind(await hash(dns.value),now+CHALLENGE_TTL,now,id).run();
  return {id,status:row.status,verification:dns};
}
function decodeTxt(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (!value.startsWith('"')) return value;
  const parts = value.match(/"(?:[^"\\]|\\.)*"/g);
  if (!parts || parts.join(' ').replace(/\s+/g,' ') !== value.replace(/\s+/g,' ')) return null;
  try { return parts.map(part => JSON.parse(part)).join(''); } catch { return null; }
}
async function boundedJson(response,max = MAX_BODY) {
  if (Number(response.headers.get('content-length')) > max) fail(413,'body_too_large','Request or response is too large.');
  const reader = response.body?.getReader();
  if (!reader) fail(400,'invalid_json','A JSON body is required.');
  const chunks=[]; let size=0;
  try {
    while (true) { const {done,value} = await reader.read(); if (done) break; size+=value.byteLength; if (size>max) { await reader.cancel(); fail(413,'body_too_large','Request or response is too large.'); } chunks.push(value); }
    const buffer = new Uint8Array(size); let offset=0; for (const part of chunks) { buffer.set(part,offset); offset+=part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
  } catch (error) { if (error instanceof ContributionError) throw error; fail(400,'invalid_json','Invalid JSON body.'); }
}

/** fetcher is an internal dependency-injection seam, never a public request field. */
export async function verifyClaim(env,id,options = {}) {
  const database=db(env); const row=await authenticatedSubmission(env,id,options); const now=nowOf(options);
  if (row.kind !== 'claim' || !['awaiting_proof','verified_owner'].includes(row.status)) fail(409,'not_claimable','This request cannot verify ownership.');
  if (!row.challenge_hash || row.challenge_expires_at <= now) fail(410,'challenge_expired','The DNS challenge expired. Request a fresh challenge.');
  const domain=canonicalDomain(await canonicalProject(row.project_id,options));
  if (domain !== row.canonical_domain) fail(409,'canonical_domain_changed','The researched project domain changed. Submit a new claim.');
  await reserveLimit(env,`dns-actor:${row.actor_key}`,now,HOUR,12);
  await reserveLimit(env,'dns-global',now,DAY,256);
  const name=`_hookline.${domain}`; const url=new URL(DNS_RESOLVER); url.searchParams.set('name',name); url.searchParams.set('type','TXT');
  let dns;
  try {
    const response=await (options.fetcher || fetch)(url.href,{method:'GET',headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('resolver unavailable');
    dns=await boundedJson(response);
  } catch { fail(503,'dns_unavailable','DNS verification is temporarily unavailable. Your claim is still awaiting proof.'); }
  if (!dns || dns.Status !== 0 || dns.TC || !Array.isArray(dns.Answer)) fail(409,'dns_proof_missing','The matching DNS TXT proof is not visible yet.');
  let matched=false;
  for (const answer of dns.Answer.slice(0,64)) {
    if (answer.type !== 16 || String(answer.name).toLowerCase().replace(/\.$/,'') !== name) continue;
    const value=decodeTxt(answer.data);
    if (value && await hash(value) === row.challenge_hash) { matched=true; break; }
  }
  if (!matched) fail(409,'dns_proof_missing','The matching DNS TXT proof is not visible yet.');
  const proof={method:'dns_txt',domain,recordName:name,resolver:DNS_RESOLVER,verifiedAt:new Date(now).toISOString(),scope:'project_metadata_only',affiliation:'domain_control',safetyEndorsement:false};
  const proofJson=JSON.stringify(proof);
  // One active owner capability per project. An agent cannot override this DNS gate.
  const results=await database.batch([
    database.prepare(`INSERT INTO project_owners(project_id,submission_id,verified_domain,verified_at,revoked_at)
      SELECT project_id,id,canonical_domain,?,NULL FROM project_submissions WHERE id = ? AND challenge_hash = ? AND challenge_expires_at > ? AND revoked_at IS NULL
      ON CONFLICT(project_id) DO UPDATE SET submission_id=excluded.submission_id,verified_domain=excluded.verified_domain,verified_at=excluded.verified_at,revoked_at=NULL
      WHERE project_owners.revoked_at IS NOT NULL OR project_owners.submission_id=excluded.submission_id
        OR EXISTS(SELECT 1 FROM project_submissions old WHERE old.id=project_owners.submission_id AND old.capability_expires_at<=?)`).bind(now,id,row.challenge_hash,now,now),
    database.prepare(`UPDATE project_submissions SET status='verified_owner',reason_code='domain_control_verified',reason_detail='Domain control verified. This authorizes metadata updates only, not measured data or a safety endorsement.',proof_json=?,challenge_hash=NULL,challenge_expires_at=NULL,updated_at=?
      WHERE id=? AND challenge_hash=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM project_owners WHERE project_id=? AND submission_id=? AND revoked_at IS NULL)`).bind(proofJson,now,id,row.challenge_hash,row.project_id,id),
    database.prepare(`INSERT INTO project_contribution_audit(id,submission_id,project_id,action,reviewer_id,reason_code,reason_detail,evidence_json,created_at)
      SELECT ?,id,project_id,'ownership_verified','dns-verifier','domain_control_verified','Canonical domain TXT challenge matched.',?,? FROM project_submissions WHERE id=? AND proof_json=? AND updated_at=?`).bind(crypto.randomUUID(),proofJson,now,id,proofJson,now),
  ]);
  if (!changes(results[1])) fail(409,'ownership_conflict','Another verified claim is active, or this challenge changed. Ownership was not reassigned.');
  return {id,status:'verified_owner',proof,message:'Domain control verified. Your receipt now permits project metadata updates only.'};
}

function metadataFrom(payload) { return {...(payload.name ? {name:payload.name} : {}),...(payload.description ? {summary:payload.description} : {}),...(payload.website ? {website:payload.website} : {})}; }
function metadataStatement(database,row,metadata,now,reviewToken) {
  return database.prepare(`INSERT INTO project_metadata(project_id,metadata_json,revision,source_submission_id,updated_at)
    SELECT project_id,?,1,id,? FROM project_submissions WHERE id=? AND status='approved' AND review_token=?
    ON CONFLICT(project_id) DO UPDATE SET metadata_json=excluded.metadata_json,revision=project_metadata.revision+1,source_submission_id=excluded.source_submission_id,updated_at=excluded.updated_at`).bind(JSON.stringify(metadata),now,row.id,reviewToken);
}
function auditStatement(database,row,action,reviewer,code,reason,evidence,before,after,now,reviewToken=null) {
  return database.prepare(`INSERT INTO project_contribution_audit(id,submission_id,project_id,action,reviewer_id,reason_code,reason_detail,evidence_json,before_json,after_json,created_at)
    SELECT ?,id,project_id,?,?,?,?,?,?,?,? FROM project_submissions WHERE id=? AND updated_at=? AND (? IS NULL OR review_token=?)`).bind(crypto.randomUUID(),action,reviewer,code,reason,JSON.stringify(evidence || {}),before ? JSON.stringify(before) : null,after ? JSON.stringify(after) : null,now,row.id,now,reviewToken,reviewToken);
}
async function currentMetadata(env,projectId) { const row=await db(env).prepare('SELECT metadata_json,revision FROM project_metadata WHERE project_id=?').bind(projectId).first(); return row ? {metadata:JSON.parse(row.metadata_json),revision:row.revision} : {metadata:{},revision:0}; }

/** Owner capability is revocable, project-scoped, and cannot edit observations/contracts. */
export async function updateClaimedMetadata(env,id,input,options = {}) {
  object(input,META_FIELDS);
  if (input.agreement !== true) fail(422,'agreement_required','Confirm this metadata is accurate.');
  const claim=await authenticatedSubmission(env,id,options); const now=nowOf(options);
  const owner=await db(env).prepare('SELECT * FROM project_owners WHERE project_id=? AND submission_id=? AND revoked_at IS NULL').bind(claim.project_id,id).first();
  if (claim.status !== 'verified_owner' || !owner) fail(403,'ownership_required','Verify the project domain before updating metadata.');
  if (owner.verified_at + PROOF_TTL <= now) fail(403,'ownership_proof_expired','Renew domain verification before updating metadata.');
  const project=await canonicalProject(claim.project_id,options);
  if (canonicalDomain(project) !== owner.verified_domain) fail(409,'canonical_domain_changed','The canonical domain changed. This capability cannot update the project.');
  const name=text(input.name,'name',100); const description=text(input.description,'description',1200); const website=publicUrl(input.website,'website');
  if (name.includes('\n') || name.includes('\r')) fail(422,'invalid_field','name must be one line.');
  if (!name && !description && !website) fail(422,'empty_update','Provide a name, description, or same-domain website update.');
  if (website && domainOf(website) !== owner.verified_domain) fail(422,'domain_change_requires_review','Changing the canonical domain requires evidence-based agent review.');
  const result=await submitContribution(env,{kind:'correction',projectId:claim.project_id,name,description,website,message:'Metadata update from a verified domain controller.',agreement:true},{...options,actorId:`owner:${id}`,requestId:null});
  const row=await db(env).prepare('SELECT * FROM project_submissions WHERE id=?').bind(result.id).first();
  const before=await currentMetadata(env,claim.project_id);
  const metadata={...before.metadata,...metadataFrom({name,description,website}),metadataProvenance:'domain-verified',metadataSourceUrl:project.website};
  const reason='Metadata-only update authorized by current canonical-domain proof.';
  const reviewToken=crypto.randomUUID();
  const outcomes=await db(env).batch([
    db(env).prepare(`UPDATE project_submissions SET status='approved',reason_code='verified_owner_metadata',reason_detail=?,updated_at=?,review_token=? WHERE id=? AND status='pending_review'
      AND EXISTS(SELECT 1 FROM project_owners o JOIN project_submissions s ON s.id=o.submission_id WHERE o.project_id=? AND o.submission_id=? AND o.revoked_at IS NULL AND s.revoked_at IS NULL AND o.verified_at>?)
      AND COALESCE((SELECT revision FROM project_metadata WHERE project_id=?),0)=?`).bind(reason,now,reviewToken,row.id,claim.project_id,id,now-PROOF_TTL,claim.project_id,before.revision),
    metadataStatement(db(env),row,metadata,now,reviewToken),
    auditStatement(db(env),row,'metadata_updated',`verified-owner:${id}`,'verified_owner_metadata',reason,{claimId:id,domain:owner.verified_domain},before.metadata,metadata,now,reviewToken),
  ]);
  if (!changes(outcomes[0])) fail(409,'ownership_changed','Ownership changed while the update was being processed. The update remains pending review.');
  const saved=await currentMetadata(env,claim.project_id);
  return {...result,status:'approved',message:reason,metadataRevision:saved.revision};
}

export async function revokeContribution(env,id,options = {}) {
  const row=await authenticatedSubmission(env,id,options); const now=nowOf(options);
  await db(env).batch([
    db(env).prepare("UPDATE project_submissions SET status='revoked',revoked_at=?,updated_at=?,reason_code='requester_revoked',reason_detail='Capability revoked by its holder.',challenge_hash=NULL,challenge_expires_at=NULL WHERE id=?").bind(now,now,id),
    db(env).prepare('UPDATE project_owners SET revoked_at=? WHERE submission_id=? AND revoked_at IS NULL').bind(now,id),
    auditStatement(db(env),row,'revoked','capability-holder','requester_revoked','Requester revoked this capability.',{},null,null,now),
  ]);
  return {id,status:'revoked',message:'Access revoked. Previously published metadata and its audit history are retained.'};
}

/** Trusted agent entry points. Never expose these without operator authentication. */
export async function listReviewQueue(env,{limit=25} = {}) {
  const rows=await db(env).prepare("SELECT * FROM project_submissions WHERE status='pending_review' ORDER BY created_at ASC LIMIT ?").bind(Math.max(1,Math.min(50,Number(limit)||25))).all();
  return {submissions:rows.results.map(row => ({...privateStatus(row),payload:JSON.parse(row.payload_json)}))};
}
export async function reviewContribution(env,id,decision,options = {}) {
  const database=db(env); const now=nowOf(options);
  const reviewer=text(options.reviewerId,'reviewerId',100,true);
  object(decision,new Set(['decision','reason','proofUrl','metadata']));
  if (!['approve','reject'].includes(decision.decision)) fail(422,'invalid_decision','Choose approve or reject.');
  const reason=text(decision.reason,'reason',1500,true); const proofUrl=publicUrl(decision.proofUrl,'proofUrl',decision.decision === 'approve');
  const row=await database.prepare('SELECT * FROM project_submissions WHERE id=?').bind(id).first();
  if (!row) fail(404,'submission_not_found','Submission not found.');
  if (row.kind === 'claim') fail(403,'dns_required','Agents cannot grant ownership. Claims must pass canonical-domain DNS verification.');
  if (row.status !== 'pending_review' || row.revoked_at) fail(409,'review_conflict','This submission is no longer pending review.');
  const payload=JSON.parse(row.payload_json);
  if (row.kind === 'project' && decision.decision === 'approve' && typeof options.getProject === 'function' && await options.getProject(row.project_id)) fail(409,'project_exists','This ID now belongs to an existing project. Review it as a correction instead.');
  const before=await currentMetadata(env,row.project_id);
  let metadata=null,authorityWebsite=null;
  if (decision.decision === 'approve') {
    const proposed=decision.metadata || {name:payload.name,description:payload.description,website:payload.website};
    object(proposed,new Set(['name','description','website']));
    const clean={name:text(proposed.name,'name',100),description:text(proposed.description,'description',1200),website:publicUrl(proposed.website,'website')};
    if (clean.name.includes('\n') || clean.name.includes('\r')) fail(422,'invalid_field','name must be one line.');
    if (row.kind === 'project' && (!clean.name || !clean.description || !clean.website)) fail(422,'incomplete_project','New projects need a name, description, and website.');
    if (!clean.name && !clean.description && !clean.website) fail(422,'empty_update','No metadata fields were approved.');
    // Domain migrations need a distinct reviewed proof, not simply the new URL.
    if (row.kind === 'correction' && clean.website) {
      const project=await canonicalProject(row.project_id,options);
      if (domainOf(clean.website) !== domainOf(project.website) && domainOf(proofUrl) !== domainOf(project.website)) fail(422,'domain_change_proof_required','A domain change requires evidence on the existing canonical project domain.');
    }
    // The reviewer must independently establish the domain against primary
    // sources. Owner-authored copy can never enter this authority table.
    if (clean.website) authorityWebsite=clean.website;
    metadata={...before.metadata,...metadataFrom(clean),metadataProvenance:'community-reviewed',metadataSourceUrl:proofUrl};
  }
  const status=decision.decision === 'approve' ? 'approved' : 'rejected';
  const code=decision.decision === 'approve' ? 'agent_reviewed_metadata' : 'agent_rejected';
  const reviewToken=crypto.randomUUID();
  const statements=[database.prepare('UPDATE project_submissions SET status=?,reason_code=?,reason_detail=?,updated_at=?,review_token=? WHERE id=? AND status=\'pending_review\' AND revoked_at IS NULL AND COALESCE((SELECT revision FROM project_metadata WHERE project_id=?),0)=?').bind(status,code,reason,now,reviewToken,id,row.project_id,before.revision)];
  if (metadata) statements.push(metadataStatement(database,row,metadata,now,reviewToken));
  if (authorityWebsite) statements.push(database.prepare(`INSERT INTO project_authorities(project_id,website,source_url,reviewed_at,source_submission_id)
    SELECT project_id,?,?,?,id FROM project_submissions WHERE id=? AND status='approved' AND review_token=?
    ON CONFLICT(project_id) DO UPDATE SET website=excluded.website,source_url=excluded.source_url,reviewed_at=excluded.reviewed_at,source_submission_id=excluded.source_submission_id`)
    .bind(authorityWebsite,proofUrl,now,id,reviewToken));
  statements.push(auditStatement(database,row,`review_${status}`,reviewer,code,reason,{proofUrl,affiliationsVerified:false},before.metadata,metadata,now,reviewToken));
  const results=await database.batch(statements);
  if (!changes(results[0])) fail(409,'review_conflict','Another review changed this submission.');
  return {id,projectId:row.project_id,status,reason:{code,message:reason},...(metadata ? {metadataRevision:(await currentMetadata(env,row.project_id)).revision} : {})};
}
export async function readProjectOverrides(env) {
  const result=await db(env).prepare('SELECT project_id,metadata_json,revision,updated_at FROM project_metadata ORDER BY project_id').all();
  const map=Object.create(null);
  for (const row of result.results) {
    const metadata=JSON.parse(row.metadata_json);
    // Explicit projection: no reviewer identity, contacts, claims, contracts, or measured fields.
    map[row.project_id]={id:row.project_id,...(metadata.name ? {name:metadata.name} : {}),...(metadata.summary ? {summary:metadata.summary} : {}),...(metadata.website ? {website:metadata.website} : {}),metadataProvenance:metadata.metadataProvenance,metadataSourceUrl:metadata.metadataSourceUrl,metadataRevision:row.revision,metadataUpdatedAt:new Date(row.updated_at).toISOString()};
  }
  return map;
}
export async function readProjectAuthority(env,projectId) {
  if (!env.DB || !SLUG.test(String(projectId || ''))) return null;
  const row=await db(env).prepare('SELECT project_id,website,source_url,reviewed_at FROM project_authorities WHERE project_id=?').bind(projectId).first();
  return row ? {id:row.project_id,website:row.website,provenance:'agent-reviewed canonical domain',
    domainSourceUrl:row.source_url,domainReviewedAt:new Date(row.reviewed_at).toISOString()} : null;
}
export async function readContributionAudit(env,projectId,{limit=50} = {}) {
  if (!SLUG.test(String(projectId || ''))) fail(422,'invalid_project','A project ID is required.');
  const result=await db(env).prepare('SELECT action,reviewer_id,reason_code,reason_detail,evidence_json,before_json,after_json,created_at,submission_id FROM project_contribution_audit WHERE project_id=? ORDER BY created_at DESC LIMIT ?').bind(projectId,Math.max(1,Math.min(100,Number(limit)||50))).all();
  return {revisions:result.results.map(row=>({submissionId:row.submission_id,action:row.action,reviewerId:row.reviewer_id,reason:{code:row.reason_code,message:row.reason_detail},evidence:JSON.parse(row.evidence_json),before:row.before_json ? JSON.parse(row.before_json) : null,after:row.after_json ? JSON.parse(row.after_json) : null,createdAt:new Date(row.created_at).toISOString()}))};
}
export async function pruneContributionLimits(env,{now=Date.now()} = {}) { return db(env).prepare('DELETE FROM project_contribution_limits WHERE expires_at < ?').bind(now-DAY).run(); }

function json(value,status=200) { return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}}); }
function bearer(request) { const value=request.headers.get('authorization') || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
async function requireReviewer(request,env) {
  if (typeof env.PROJECT_REVIEW_TOKEN !== 'string' || env.PROJECT_REVIEW_TOKEN.length < 32) fail(503,'review_agent_unconfigured','The review agent API is not configured.');
  const candidate=bearer(request);
  if (!candidate || await hash(candidate) !== await hash(env.PROJECT_REVIEW_TOKEN)) fail(403,'review_access_denied','Review access denied.');
}
function sameOrigin(request) {
  const origin=request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) fail(403,'origin_not_allowed','Use the Hookline API directly or the same-origin project form.');
}
/** Returns null outside this API namespace. No query-string credentials accepted. */
export async function handleContributionRequest(request,env,options = {}) {
  const url=new URL(request.url); const prefix='/api/project-submissions';
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  try {
    if ([...url.searchParams.keys()].some(key => /token|secret|receipt|key|capability/i.test(key))) fail(400,'credentials_in_url','Send credentials only in the Authorization header.');
    if (!['GET','POST'].includes(request.method)) return json({error:{code:'method_not_allowed',message:'Use GET or POST.'}},405);
    if (request.method === 'POST') sameOrigin(request);
    if (url.pathname === `${prefix}/review-queue` && request.method === 'GET') { await requireReviewer(request,env); return json(await listReviewQueue(env)); }
    if (url.pathname === prefix && request.method === 'POST') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415,'json_required','Send application/json.');
      // Cloudflare owns this header. X-Forwarded-For and submitted actor IDs are never trusted.
      const ip=request.headers.get('cf-connecting-ip');
      const actorId=ip && /^[0-9a-fA-F:.]{3,64}$/.test(ip) ? `public:${ip}` : 'public:shared';
      const result=await submitContribution(env,await boundedJson(request),{...options,actorId,telegramUserId:undefined,chatId:undefined,requestId:undefined});
      return json(result,201);
    }
    const match=url.pathname.match(/^\/api\/project-submissions\/([a-f0-9-]{36})(?:\/(challenge|verify|metadata|revoke|review))?$/);
    if (!match) return json({error:{code:'not_found',message:'Endpoint not found.'}},404);
    const [,id,action]=match;
    if (action === 'review' && request.method === 'POST') {
      await requireReviewer(request,env);
      return json(await reviewContribution(env,id,await boundedJson(request),{...options,reviewerId:'authenticated-review-agent'}));
    }
    const privateOptions={...options,receiptToken:bearer(request),telegramUserId:undefined,chatId:undefined};
    if (!action && request.method === 'GET') return json(await getContributionStatus(env,id,privateOptions));
    if (request.method !== 'POST') return json({error:{code:'method_not_allowed',message:'Use POST for this action.'}},405);
    if (action === 'challenge') return json(await issueClaimChallenge(env,id,privateOptions));
    if (action === 'verify') return json(await verifyClaim(env,id,privateOptions));
    if (action === 'metadata') return json(await updateClaimedMetadata(env,id,await boundedJson(request),privateOptions));
    if (action === 'revoke') return json(await revokeContribution(env,id,privateOptions));
    return json({error:{code:'not_found',message:'Endpoint not found.'}},404);
  } catch (error) {
    if (error instanceof ContributionError) return json({error:{code:error.code,message:error.message}},error.status);
    // Never reflect DB errors, submission payloads, or credentials to public callers.
    return json({error:{code:'contributions_unavailable',message:'Project contributions are temporarily unavailable. Please retry later.'}},503);
  }
}
