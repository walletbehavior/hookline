/**
 * Private wallet-authenticated account data. This module never creates wallets,
 * receives keys, approves tokens, signs transactions, or grants trading authority.
 *
 * HTTP integration: return handleAccountsApi(request,env,services) when non-null.
 * D1: apply migrations 0005_accounts and 0006_contract_account_auth first.
 * All responses are private/no-store.
 * Services are trusted server injections, never request-derived:
 *   now?: () => epochMilliseconds
 *   verifySmartWalletSignature?: async ({address,chainId,message,signature,hash,signal}) => boolean
 * The smart-wallet verifier must check a DEPLOYED wallet's EIP-1271 signature on
 * the explicit requested chain. Do not deploy wallets or accept counterfactual
 * signatures here. EOA verification uses viem's real EIP-191 verifier by default.
 */
import {getAddress,hashMessage,verifyMessage} from 'viem';
import {createSiweMessage} from 'viem/siwe';
import {
  AccountError,fail,object,integer,address,revision,validateWatchlists,
  validatePreferencesPatch,defaultAccountPreferences,privateTelegramIdentity,
  WATCHLIST_MAX_BYTES,
} from './validation.js';
export {AccountError,validateWatchlists,validatePreferencesPatch,defaultAccountPreferences} from './validation.js';

export const ACCOUNT_ORIGIN='https://hookline.world';
export const ACCOUNT_DOMAIN='hookline.world';
export const ACCOUNT_URI=`${ACCOUNT_ORIGIN}/`;
export const ACCOUNT_SESSION_COOKIE='__Host-hln_session';
export const ACCOUNT_BROWSER_COOKIE='__Host-hln_login';
export const ACCOUNT_CHALLENGE_TTL_MS=600000;
export const ACCOUNT_SESSION_TTL_MS=604800000;
export const ACCOUNT_LINK_TTL_MS=600000;
export const ACCOUNT_LOGIN_CHAINS=Object.freeze([1,56,4663,8453,42161]);
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATEMENT='Sign in to Hookline to save private watchlists and preferences. This does not authorize trading, token approvals, or transfers.';
const iso=timestamp=>new Date(timestamp).toISOString();
const unavailable=()=>new AccountError(503,'accounts_unavailable','Account storage is temporarily unavailable. Your existing data has not been replaced.');
function db(env) {if(!env?.DB?.prepare||!env.DB.batch) throw unavailable();return env.DB;}
function time(services={}) {const n=services.now?services.now():Date.now();if(!Number.isSafeInteger(n)||n<0) throw unavailable();return n;}
function token() {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function hash(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function equal(a,b) {if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false;let n=0;for(let i=0;i<a.length;i++) n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function cookie(name,value,maxAge) {return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;}
function getCookie(request,name) {
  const source=request.headers.get('cookie')||'';if(source.length>16384) return null;
  const matches=source.split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${name}=`));
  if(matches.length!==1) return null;const value=matches[0].slice(name.length+1);return TOKEN.test(value)?value:null;
}
function assertContext(request) {
  const url=new URL(request.url);
  if(url.origin!==ACCOUNT_ORIGIN||url.username||url.password) fail(403,'invalid_origin','Use your account on https://hookline.world.');
  const origin=request.headers.get('origin');const mutation=!['GET','HEAD'].includes(request.method);
  if((origin&&origin!==ACCOUNT_ORIGIN)||(mutation&&origin!==ACCOUNT_ORIGIN)) fail(403,'invalid_origin','This account request must originate from Hookline.');
  const site=request.headers.get('sec-fetch-site');
  if(site&&site!=='same-origin'&&site!=='none') fail(403,'invalid_origin','Cross-site account requests are not allowed.');
}
function response(body,status=200,cookies=[]) {
  const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Cookie, Origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  for(const item of cookies) headers.append('Set-Cookie',item);
  return new Response(JSON.stringify(body),{status,headers});
}
function publicAccount(account) {return {id:account.id,address:account.address,chainId:account.chainId};}
async function readJson(request,max=16384,{empty=false}={}) {
  const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>max)) fail(413,'request_too_large','This account request is too large.');
  const type=request.headers.get('content-type')||'';
  if(!/^application\/json(?:\s*;|$)/i.test(type)&&!(empty&&!type)) fail(415,'json_required','Send this request as application/json.');
  let text='';let size=0;
  if(request.body) {
    const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
    try {for(;;){const {done,value}=await reader.read();if(done) break;size+=value.length;if(size>max){await reader.cancel();fail(413,'request_too_large','This account request is too large.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
    catch(error) {if(error instanceof AccountError) throw error;fail(400,'invalid_json','Send valid UTF-8 JSON.');}
    finally {reader.releaseLock();}
  }
  if(empty&&!text) return {};
  try {return JSON.parse(text);} catch {fail(400,'invalid_json','Send valid JSON.');}
}
function canonicalMessage(row) {
  return createSiweMessage({address:row.address,chainId:row.chain_id,domain:ACCOUNT_DOMAIN,scheme:'https',uri:ACCOUNT_URI,version:'1',nonce:row.nonce,issuedAt:new Date(row.created_at),expirationTime:new Date(row.expires_at),requestId:row.id,statement:STATEMENT});
}
async function limit(database,key,maximum,period,now) {
  const window=Math.floor(now/period),expiry=(window+1)*period;
  const result=await database.prepare(`INSERT INTO account_auth_limits(bucket_key,hits,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET hits=account_auth_limits.hits+1 WHERE account_auth_limits.hits<? RETURNING hits`).bind(`${key}:${window}`,expiry,maximum).first();
  if(!result) fail(429,'rate_limited','Too many account requests. Please try again later.');
}
async function challengeLimits(database,request,wallet,now) {
  // Cloudflare overwrites CF-Connecting-IP. X-Forwarded-For and user IDs are not
  // trusted here; deployments without Cloudflare share one anonymous bucket.
  const raw=request.headers.get('cf-connecting-ip');
  const trusted=raw&&raw.length<=64&&/^[0-9a-fA-F:.]+$/.test(raw)?raw:'shared-public';
  await limit(database,'challenge:global',2000,86400000,now);
  await limit(database,`challenge:ip:${await hash(trusted)}`,30,3600000,now);
  await limit(database,`challenge:wallet:${wallet}`,10,3600000,now);
}

/** Returns internal identity or null. Do not serialize sessionHash. Database
 * failures throw, never silently convert a previously saved account to guest.
 * Downstream mutation routes MUST additionally call requireAccountCsrf.
 */
export async function getAuthenticatedAccount(request,env,services={}) {
  assertContext(request);const raw=getCookie(request,ACCOUNT_SESSION_COOKIE);if(!raw) return null;
  try {
    const sessionHash=await hash(`session:${raw}`),now=time(services);
    const row=await db(env).prepare(`SELECT s.account_address,s.chain_id,s.expires_at FROM account_sessions s
      JOIN accounts a ON a.address=s.account_address WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND (a.auth_method='eoa' OR (a.auth_method='eip1271' AND a.auth_chain_id=s.chain_id))`).bind(sessionHash,now).first();
    if(!row) return null;
    return {id:row.account_address,address:row.account_address,chainId:row.chain_id,sessionHash,csrfToken:await hash(`csrf:${raw}`),expiresAt:iso(row.expires_at)};
  } catch(error) {if(error instanceof AccountError) throw error;throw unavailable();}
}
export function requireAccountCsrf(request,account) {
  assertContext(request);
  if(!account) fail(401,'sign_in_required','Sign in with your wallet first.');
  if(!equal(request.headers.get('x-hookline-csrf'),account.csrfToken)) fail(403,'invalid_csrf','Refresh your account session before making this change.');
}
async function issueChallenge(request,env,services) {
  const input=object(await readJson(request),['address','chainId']);const wallet=address(input.address);
  const chainId=integer(input.chainId,1,4294967295,'invalid_chain','Chain ID');
  if(!ACCOUNT_LOGIN_CHAINS.includes(chainId)) fail(422,'unsupported_chain','Sign in on Ethereum, Base, BNB Chain, Arbitrum, or Robinhood Chain.');
  const database=db(env),now=time(services);await challengeLimits(database,request,wallet,now);
  const browserToken=token();const row={id:crypto.randomUUID(),address:wallet,chain_id:chainId,nonce:token().replace(/[_-]/g,'A'),created_at:now,expires_at:now+ACCOUNT_CHALLENGE_TTL_MS};
  const message=canonicalMessage(row);
  await database.prepare(`INSERT INTO account_challenges(id,address,chain_id,nonce,message,browser_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(row.id,wallet,chainId,row.nonce,message,await hash(`browser:${browserToken}`),now,row.expires_at).run();
  return response({ok:true,challengeId:row.id,message,expiresAt:iso(row.expires_at),chainId,domain:ACCOUNT_DOMAIN,uri:ACCOUNT_URI},200,[cookie(ACCOUNT_BROWSER_COOKIE,browserToken,ACCOUNT_CHALLENGE_TTL_MS/1000)]);
}
async function validSignature(row,signature,services) {
  try {if(await verifyMessage({address:getAddress(row.address),message:row.message,signature})) return 'eoa';} catch {/* Contract signatures need the explicit verifier below. */}
  if(!services.verifySmartWalletSignature) return null;
  const controller=new AbortController();let timer;
  try {
    const timedOut=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AccountError(503,'signature_verifier_unavailable','Wallet signature verification is temporarily unavailable.'));},6000);});
    return (await Promise.race([services.verifySmartWalletSignature({address:row.address,chainId:row.chain_id,message:row.message,signature,hash:hashMessage(row.message),signal:controller.signal}),timedOut]))===true?'eip1271':null;
  } catch(error) {if(error instanceof AccountError) throw error;throw new AccountError(503,'signature_verifier_unavailable','Wallet signature verification is temporarily unavailable.');}
  finally {clearTimeout(timer);}
}
async function login(request,env,services) {
  const input=object(await readJson(request,16384),['challengeId','signature']);
  if(typeof input.challengeId!=='string'||!UUID.test(input.challengeId)||typeof input.signature!=='string'||!/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(input.signature)) fail(422,'invalid_signature_request','Provide the issued challenge and wallet signature.');
  const browser=getCookie(request,ACCOUNT_BROWSER_COOKIE);
  if(!browser) fail(401,'invalid_challenge','The sign-in challenge is missing, expired, or belongs to another browser.');
  const database=db(env),now=time(services),browserHash=await hash(`browser:${browser}`);
  const row=await database.prepare(`UPDATE account_challenges SET attempts=attempts+1 WHERE id=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? AND created_at<=? AND attempts<5 RETURNING *`)
    .bind(input.challengeId,browserHash,now,now).first();
  if(!row) fail(401,'invalid_challenge','The sign-in challenge is missing, used, expired, or belongs to another browser.');
  // A submitted message is never accepted. Everything signed is reconstructed
  // from the server-issued nonce, origin, URI, chain, address, and exact times.
  if(row.expires_at-row.created_at!==ACCOUNT_CHALLENGE_TTL_MS||!ACCOUNT_LOGIN_CHAINS.includes(row.chain_id)||row.message!==canonicalMessage(row)) throw unavailable();
  const authMethod=await validSignature(row,input.signature,services);
  if(!authMethod) fail(401,'invalid_signature','The signature does not authorize this wallet to sign in.');
  const authChain=authMethod==='eip1271'?row.chain_id:null;
  const existing=await database.prepare('SELECT auth_method,auth_chain_id FROM accounts WHERE address=?').bind(row.address).first();
  if(existing&&(existing.auth_method!==authMethod||existing.auth_chain_id!==authChain)) fail(403,'account_identity_conflict','This address is already registered with a different wallet type or smart-wallet chain. Use the original wallet and chain; accounts are not merged.');
  const finishedAt=time(services),expiresAt=finishedAt+ACCOUNT_SESSION_TTL_MS;
  if(finishedAt>=row.expires_at) fail(401,'expired_challenge','The sign-in challenge expired. Request a new one.');
  const sessionToken=token(),sessionHash=await hash(`session:${sessionToken}`),operation=crypto.randomUUID();
  const oldSession=getCookie(request,ACCOUNT_SESSION_COOKIE),oldHash=oldSession?await hash(`session:${oldSession}`):'';
  const claimed=`EXISTS(SELECT 1 FROM account_challenges WHERE id=? AND consumed_by=?)`;
  const results=await database.batch([
    database.prepare(`UPDATE account_challenges SET consumed_at=?,consumed_by=? WHERE id=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>?`).bind(finishedAt,operation,row.id,browserHash,finishedAt),
    database.prepare(`INSERT INTO accounts(address,created_at,last_login_at,auth_method,auth_chain_id) SELECT ?,?,?,?,? WHERE ${claimed}
      ON CONFLICT(address) DO UPDATE SET last_login_at=MAX(accounts.last_login_at,excluded.last_login_at)
      WHERE accounts.auth_method=excluded.auth_method AND accounts.auth_chain_id IS excluded.auth_chain_id`).bind(row.address,finishedAt,finishedAt,authMethod,authChain,row.id,operation),
    database.prepare(`INSERT INTO account_sessions(token_hash,account_address,chain_id,created_at,expires_at) SELECT ?,?,?,?,? WHERE ${claimed}
      AND EXISTS(SELECT 1 FROM accounts WHERE address=? AND auth_method=? AND auth_chain_id IS ?)`).bind(sessionHash,row.address,row.chain_id,finishedAt,expiresAt,row.id,operation,row.address,authMethod,authChain),
    database.prepare(`UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=?)`).bind(finishedAt,oldHash,sessionHash),
    database.prepare(`UPDATE account_sessions SET revoked_at=? WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE account_address=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,(token_hash=?) DESC,token_hash DESC LIMIT -1 OFFSET 10) AND EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=?)`).bind(finishedAt,row.address,finishedAt,sessionHash,sessionHash),
  ]);
  if(results[0]?.meta?.changes!==1) fail(409,'challenge_already_used','This challenge has already been used. Request a new one.');
  if(results[2]?.meta?.changes!==1) fail(403,'account_identity_conflict','This address is already registered with a different wallet type or smart-wallet chain. Use the original wallet and chain; accounts are not merged.');
  const account={id:row.address,address:row.address,chainId:row.chain_id};
  return response({ok:true,authenticated:true,account,csrfToken:await hash(`csrf:${sessionToken}`),expiresAt:iso(expiresAt)},200,[cookie(ACCOUNT_SESSION_COOKIE,sessionToken,ACCOUNT_SESSION_TTL_MS/1000),cookie(ACCOUNT_BROWSER_COOKIE,'',0)]);
}

function decodeDocument(kind,row) {
  if(!row) return {[kind]:kind==='watchlists'?null:defaultAccountPreferences(),revision:0,updatedAt:null};
  try {
    const parsed=JSON.parse(row.document_json);
    const value=kind==='watchlists'?validateWatchlists(parsed):validatePreferencesPatch(parsed);
    if(kind==='preferences'&&Object.keys(value).length!==3) throw unavailable();
    if(!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.updated_at)) throw unavailable();
    return {[kind]:value,revision:row.revision,updatedAt:iso(row.updated_at)};
  } catch {throw unavailable();}
}
async function document(database,account,kind) {
  return decodeDocument(kind,await database.prepare('SELECT document_json,revision,updated_at FROM account_documents WHERE account_address=? AND kind=?').bind(account.id,kind).first());
}
async function writeDocument(request,database,account,kind,services) {
  const input=object(await readJson(request,kind==='watchlists'?WATCHLIST_MAX_BYTES+4096:8192),kind==='watchlists'?['revision','watchlists']:['revision','patch']);
  const expected=revision(input.revision),now=time(services);
  const value=kind==='watchlists'?validateWatchlists(input.watchlists):validatePreferencesPatch(input.patch);
  const current=await document(database,account,kind);
  if(current.revision!==expected) fail(409,'revision_conflict','Saved data changed in another session. Refresh it before merging your changes.',{revision:current.revision});
  await limit(database,'document:global',20000,86400000,now);
  await limit(database,`document:${account.id}`,60,60000,now);
  const serialized=JSON.stringify(kind==='preferences'?{...current.preferences,...value}:value);
  const validSession=`EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=? AND account_address=? AND revoked_at IS NULL AND expires_at>?)`;
  let row;
  if(expected===0) row=await database.prepare(`INSERT INTO account_documents(account_address,kind,document_json,revision,updated_at)
    SELECT ?,?,?,1,? WHERE ${validSession} ON CONFLICT(account_address,kind) DO NOTHING RETURNING document_json,revision,updated_at`)
    .bind(account.id,kind,serialized,now,account.sessionHash,account.id,now).first();
  else row=await database.prepare(`UPDATE account_documents SET document_json=?,revision=revision+1,updated_at=MAX(updated_at,?) WHERE account_address=? AND kind=? AND revision=? AND ${validSession} RETURNING document_json,revision,updated_at`)
    .bind(serialized,now,account.id,kind,expected,account.sessionHash,account.id,now).first();
  if(!row) {
    const active=await database.prepare('SELECT 1 AS ok FROM account_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(account.sessionHash,now).first();
    if(!active) fail(401,'sign_in_required','Your session ended. Sign in before saving changes.');
    const latest=await document(database,account,kind);fail(409,'revision_conflict','Saved data changed in another session. Refresh it before merging your changes.',{revision:latest.revision});
  }
  return response({ok:true,...decodeDocument(kind,row)});
}
async function linkStatus(database,account) {
  const row=await database.prepare('SELECT telegram_user_id,linked_at FROM account_telegram_links WHERE account_address=?').bind(account.id).first();
  return row?{linked:true,telegramUserId:row.telegram_user_id,linkedAt:iso(row.linked_at)}:{linked:false};
}
async function issueTelegramLink(request,database,account,services) {
  object(await readJson(request,1024,{empty:true}),[]);const now=time(services);
  if((await linkStatus(database,account)).linked) fail(409,'telegram_already_linked','Unlink the existing Telegram identity before linking a different one.');
  await limit(database,'telegram-link:global',2000,86400000,now);
  await limit(database,`telegram-link:${account.id}`,10,3600000,now);
  const raw=token(),digest=await hash(`link:${raw}`),expiresAt=now+ACCOUNT_LINK_TTL_MS;
  const results=await database.batch([
    database.prepare('UPDATE account_telegram_link_tokens SET revoked_at=? WHERE account_address=? AND consumed_at IS NULL AND revoked_at IS NULL').bind(now,account.id),
    database.prepare(`INSERT INTO account_telegram_link_tokens(token_hash,account_address,session_hash,created_at,expires_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=? AND account_address=? AND revoked_at IS NULL AND expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM account_telegram_links WHERE account_address=?)`).bind(digest,account.id,account.sessionHash,now,expiresAt,account.sessionHash,account.id,now,account.id),
  ]);
  if(results[1]?.meta?.changes!==1) fail(409,'link_not_available','Your session or Telegram link changed. Refresh your account before trying again.');
  return response({ok:true,token:raw,expiresAt:iso(expiresAt)});
}

/** Consume only inside the authenticated Telegram webhook, using update-derived
 * userId, chatId, fromId, and chatType. Website sign-in plus possession of its
 * one-time link token authorizes that exact private Telegram identity. The
 * website can inspect/revoke the link. No account merging or settings copying.
 * Throws AccountError on invalid, expired, replayed, or conflicting links.
 */
export async function consumeTelegramLink(env,context,services={}) {
  const user=privateTelegramIdentity(context);
  if(typeof context?.token!=='string'||!TOKEN.test(context.token)) fail(422,'invalid_link_token','Use the account-link code from your signed-in Hookline account.');
  try {
    const database=db(env),now=time(services),digest=await hash(`link:${context.token}`),operation=crypto.randomUUID();
    const row=await database.prepare(`SELECT t.account_address,t.expires_at,t.consumed_at,t.revoked_at FROM account_telegram_link_tokens t JOIN account_sessions s ON s.token_hash=t.session_hash
      WHERE t.token_hash=? AND s.account_address=t.account_address AND s.revoked_at IS NULL AND s.expires_at>?`).bind(digest,now).first();
    if(!row||row.consumed_at!==null||row.revoked_at!==null||row.expires_at<=now) fail(401,'invalid_link_token','This account-link code is invalid, expired, or already used.');
    const conflict=await database.prepare('SELECT account_address FROM account_telegram_links WHERE account_address=? OR telegram_user_id=? LIMIT 1').bind(row.account_address,user).first();
    if(conflict) fail(409,'telegram_link_conflict','That wallet or Telegram identity is already linked. Unlink it from the signed-in website before making a new link.');
    const results=await database.batch([
      database.prepare(`UPDATE account_telegram_link_tokens SET consumed_at=?,consumed_by=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?
        AND EXISTS(SELECT 1 FROM account_sessions s WHERE s.token_hash=account_telegram_link_tokens.session_hash AND s.account_address=account_telegram_link_tokens.account_address AND s.revoked_at IS NULL AND s.expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM account_telegram_links l WHERE l.account_address=account_telegram_link_tokens.account_address OR l.telegram_user_id=?)`).bind(now,operation,digest,now,now,user),
      database.prepare(`INSERT INTO account_telegram_links(account_address,telegram_user_id,linked_at) SELECT account_address,?,? FROM account_telegram_link_tokens WHERE token_hash=? AND consumed_by=?`).bind(user,now,digest,operation),
    ]);
    if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1) fail(409,'telegram_link_conflict','This link was used or the account changed. Request a new link from the website.');
    return {linked:true,account:{id:row.account_address,address:row.account_address},telegramUserId:user,linkedAt:iso(now)};
  } catch(error) {if(error instanceof AccountError) throw error;throw unavailable();}
}

/** Minimal server-only lookup for authenticated private Telegram features. This
 * identifies a linked data account, never wallet execution or signing authority.
 */
export async function getTelegramAccount(env,context,services={}) {
  const user=privateTelegramIdentity(context);time(services);
  try {const row=await db(env).prepare('SELECT account_address,linked_at FROM account_telegram_links WHERE telegram_user_id=?').bind(user).first();return row?{id:row.account_address,address:row.account_address,linkedAt:iso(row.linked_at)}:null;}
  catch(error) {if(error instanceof AccountError) throw error;throw unavailable();}
}

/** Bounded scheduled housekeeping. No account documents or active links deleted.
 * Do not expose as a public route. Each table deletes at most 500 expired rows.
 */
export async function pruneAccountEphemera(env,services={}) {
  const database=db(env),now=time(services);
  try {
    const result=await database.batch([
      database.prepare('DELETE FROM account_challenges WHERE id IN (SELECT id FROM account_challenges WHERE expires_at<? LIMIT 500)').bind(now),
      database.prepare('DELETE FROM account_telegram_link_tokens WHERE token_hash IN (SELECT token_hash FROM account_telegram_link_tokens WHERE expires_at<? LIMIT 500)').bind(now),
      database.prepare('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE expires_at<? LIMIT 500)').bind(now),
      database.prepare('DELETE FROM account_auth_limits WHERE bucket_key IN (SELECT bucket_key FROM account_auth_limits WHERE expires_at<? LIMIT 500)').bind(now),
    ]);return {deleted:result.reduce((sum,item)=>sum+(item.meta?.changes||0),0)};
  } catch {throw unavailable();}
}

/**
 * Success JSON: {ok:true,...}. Errors: {ok:false,error:{code,message},revision?}.
 * GET session -> {authenticated,account?,csrfToken?,expiresAt?}.
 * POST challenge {address,chainId} -> {challengeId,message,expiresAt,domain,uri,chainId}.
 * POST login {challengeId,signature} -> authenticated session + HttpOnly cookie.
 * GET/PUT watchlists -> {watchlists,revision,updatedAt}; PUT {revision,watchlists}.
 * GET/PUT preferences -> {preferences,revision,updatedAt}; PUT {revision,patch}.
 * POST telegram-link -> {token,expiresAt}; GET -> {linked,telegramUserId?,linkedAt?}.
 * DELETE telegram-link, POST logout, POST logout-all -> {ok:true}.
 * Every authenticated mutation requires X-Hookline-CSRF from GET session/login.
 */
export async function handleAccountsApi(request,env,services={}) {
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/account/')) return null;
  try {
    assertContext(request);
    if(url.search) fail(400,'query_not_allowed','Account credentials and data must not be sent in URLs.');
    const route=url.pathname.slice('/api/account/'.length),method=request.method;
    if(route==='challenge'&&method==='POST') return await issueChallenge(request,env,services);
    if(route==='login'&&method==='POST') return await login(request,env,services);
    const known={session:['GET'],watchlists:['GET','PUT'],preferences:['GET','PUT'],'telegram-link':['GET','POST','DELETE'],logout:['POST'],'logout-all':['POST'],challenge:['POST'],login:['POST']};
    if(!Object.hasOwn(known,route)) fail(404,'not_found','Account endpoint not found.');
    if(!known[route].includes(method)) fail(405,'method_not_allowed','This method is not available for the account endpoint.');
    const account=await getAuthenticatedAccount(request,env,services);
    if(route==='session') return response(account?{ok:true,authenticated:true,account:publicAccount(account),csrfToken:account.csrfToken,expiresAt:account.expiresAt}:{ok:true,authenticated:false});
    if(!account) fail(401,'sign_in_required','Sign in with your wallet first.');
    if(method!=='GET') requireAccountCsrf(request,account);
    const database=db(env);
    if(route==='watchlists'||route==='preferences') return method==='GET'?response({ok:true,...await document(database,account,route)}):await writeDocument(request,database,account,route,services);
    if(route==='telegram-link') {
      if(method==='GET') return response({ok:true,...await linkStatus(database,account)});
      if(method==='POST') return await issueTelegramLink(request,database,account,services);
      object(await readJson(request,1024,{empty:true}),[]);const now=time(services);
      await database.batch([
        database.prepare('DELETE FROM account_telegram_links WHERE account_address=?').bind(account.id),
        database.prepare('UPDATE account_telegram_link_tokens SET revoked_at=? WHERE account_address=? AND revoked_at IS NULL').bind(now,account.id),
      ]);return response({ok:true});
    }
    if(route==='logout'||route==='logout-all') {
      object(await readJson(request,1024,{empty:true}),[]);
      const now=time(services);
      await database.prepare(`UPDATE account_sessions SET revoked_at=? WHERE ${route==='logout'?'token_hash':'account_address'}=? AND revoked_at IS NULL`).bind(now,route==='logout'?account.sessionHash:account.id).run();
      return response({ok:true},200,[cookie(ACCOUNT_SESSION_COOKIE,'',0),cookie(ACCOUNT_BROWSER_COOKIE,'',0)]);
    }
    fail(404,'not_found','Account endpoint not found.');
  } catch(error) {
    const safe=error instanceof AccountError?error:unavailable();
    const result=response({ok:false,error:{code:safe.code,message:safe.message},...(Number.isSafeInteger(safe.details?.revision)?{revision:safe.details.revision}:{})},safe.status);
    if(safe.status===429) result.headers.set('Retry-After','60');return result;
  }
}
