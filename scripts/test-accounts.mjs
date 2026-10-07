import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {privateKeyToAccount} from 'viem/accounts';
import {parseSiweMessage} from 'viem/siwe';
import {createEip1271Verifier} from '../accounts/contract-signatures.js';
import {
  handleAccountsApi,getAuthenticatedAccount,requireAccountCsrf,consumeTelegramLink,
  getTelegramAccount,pruneAccountEphemera,AccountError,validateWatchlists,
  validatePreferencesPatch,defaultAccountPreferences,ACCOUNT_ORIGIN,
  ACCOUNT_SESSION_COOKIE,ACCOUNT_BROWSER_COOKIE,ACCOUNT_SESSION_TTL_MS,
  ACCOUNT_CHALLENGE_TTL_MS,ACCOUNT_LINK_TTL_MS,
} from '../accounts/index.js';

// Public deterministic test keys only. Never reads a user's wallet or secrets.
const alice=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const bob=privateKeyToAccount(`0x${'2'.padStart(64,'0')}`);
const carol=privateKeyToAccount(`0x${'3'.padStart(64,'0')}`);
const START=Date.parse('2026-10-07T22:00:00.000Z');
class D1 {
  constructor({migrate=true}={}) {this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON');this.calls=0;if(migrate)for(const file of ['0005_accounts.sql','0006_contract_account_auth.sql'])this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));}
  prepare(sql) {
    this.calls++;const database=this;let args=[];
    return {
      sql,get args(){return args;},bind(...values){args=values;return this;},
      async first(){return database.sqlite.prepare(sql).get(...args)||null;},
      async all(){return {results:database.sqlite.prepare(sql).all(...args)};},
      async run(){const result=database.sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {const results=statements.map(statement=>{const result=this.sqlite.prepare(statement.sql).run(...statement.args);return {meta:{changes:Number(result.changes)}};});this.sqlite.exec('COMMIT');return results;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}
function fixture(options={}) {const env={DB:new D1(options)},clock={now:START};return {env,clock,services:{now:()=>clock.now}};}
class Browser {
  constructor(f,extra={}) {this.f=f;this.cookies=new Map();this.extra=extra;this.csrf=null;}
  request(path,method='GET',body,options={}) {
    const headers=new Headers({'cf-connecting-ip':'203.0.113.9',...(method!=='GET'?{'Origin':ACCOUNT_ORIGIN}:{}),...this.extra,...options.headers});
    if(this.cookies.size&&!options.noCookie)headers.set('cookie',[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '));
    if(this.csrf&&!options.noCsrf)headers.set('X-Hookline-CSRF',this.csrf);
    if(options.cookie!==undefined)headers.set('cookie',options.cookie);
    for(const header of options.removeHeaders||[])headers.delete(header);
    let encoded=body===undefined?undefined:JSON.stringify(body);
    if(body!==undefined)headers.set('content-type','application/json');
    if(options.rawBody!==undefined)encoded=options.rawBody;
    return new Request(options.url||`${ACCOUNT_ORIGIN}/api/account/${path}`,{method,headers,body:encoded});
  }
  async call(path,method='GET',body,options={}) {
    const request=this.request(path,method,body,options),response=await handleAccountsApi(request,this.f.env,options.services||this.f.services);
    if(!response)return null;
    for(const entry of response.headers.getSetCookie()){const [part]=entry.split(';'),i=part.indexOf('='),key=part.slice(0,i),value=part.slice(i+1);if(value)this.cookies.set(key,value);else this.cookies.delete(key);}
    const json=await response.json();if(json.csrfToken)this.csrf=json.csrfToken;
    return {response,status:response.status,body:json,request};
  }
  async challenge(wallet=alice,chainId=8453) {const result=await this.call('challenge','POST',{address:wallet.address,chainId});assert.equal(result.status,200,JSON.stringify(result.body));return result;}
  async signIn(wallet=alice) {const challenge=await this.challenge(wallet);const signature=await wallet.signMessage({message:challenge.body.message});const result=await this.call('login','POST',{challengeId:challenge.body.challengeId,signature});assert.equal(result.status,200,JSON.stringify(result.body));return result;}
}
function count(f,table){return f.env.DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;}
function sql(f,query,...args){return f.env.DB.sqlite.prepare(query).get(...args);}
const tg=(user='12345')=>({userId:user,chatId:user,fromId:user,chatType:'private'});
const lists=()=>({version:3,activeListId:'list-a',lists:[{id:'list-a',name:'Research',createdAt:START,items:[{id:'hook-a',chainId:8453,address:alice.address,label:'A useful hook'}]}]});
async function expectCode(call,status,code){const result=await call;assert.equal(result.status,status,JSON.stringify(result.body));assert.equal(result.body.error.code,code);return result;}
async function rejectCode(call,code){await assert.rejects(call,e=>e instanceof AccountError&&e.code===code);}
async function issueLink(browser){const result=await browser.call('telegram-link','POST');assert.equal(result.status,200,JSON.stringify(result.body));return result.body.token;}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('unrelated routes are untouched, guest session is private and unsaved',async()=>{
  const f=fixture(),b=new Browser(f);
  assert.equal(await handleAccountsApi(new Request(`${ACCOUNT_ORIGIN}/api/projects`),f.env,f.services),null);
  const result=await b.call('session');assert.deepEqual(result.body,{ok:true,authenticated:false});assert.equal(f.env.DB.calls,0);
  assert.match(result.response.headers.get('cache-control'),/private, no-store/);assert.equal(result.response.headers.get('referrer-policy'),'no-referrer');assert.equal(result.response.headers.get('access-control-allow-origin'),null);
});
test('challenge is canonical EIP-4361, ten minutes, browser-bound and contains no spending authority',async()=>{
  const f=fixture(),b=new Browser(f),result=await b.challenge();const message=parseSiweMessage(result.body.message);
  assert.equal(message.domain,'hookline.world');assert.equal(message.scheme,'https');assert.equal(message.uri,`${ACCOUNT_ORIGIN}/`);assert.equal(message.version,'1');assert.equal(message.chainId,8453);assert.equal(message.address,alice.address);assert.equal(message.issuedAt.getTime(),START);assert.equal(message.expirationTime.getTime(),START+600000);assert.match(message.nonce,/^[A-Za-z0-9]{8,}$/);assert.match(message.statement,/does not authorize trading/);
  const raw=b.cookies.get(ACCOUNT_BROWSER_COOKIE),row=sql(f,'SELECT * FROM account_challenges');assert.equal(row.browser_hash.length,64);assert.ok(!JSON.stringify(row).includes(raw));assert.equal(count(f,'accounts'),0);
  const header=result.response.headers.get('set-cookie');assert.match(header,/__Host-hln_login=/);for(const flag of ['Path=/','Max-Age=600','HttpOnly','Secure','SameSite=Strict'])assert.ok(header.includes(flag));assert.ok(!header.includes('Domain='));assert.match(result.response.headers.get('cache-control'),/no-store/);
});
test('real EOA signature creates hashed seven-day session and sanitized public identity',async()=>{
  const f=fixture(),b=new Browser(f),result=await b.signIn();
  assert.equal(result.body.account.id,alice.address.toLowerCase());assert.equal(result.body.authenticated,true);assert.equal(result.body.expiresAt,new Date(START+ACCOUNT_SESSION_TTL_MS).toISOString());assert.equal(result.body.csrfToken.length,64);
  assert.equal(b.cookies.has(ACCOUNT_BROWSER_COOKIE),false);const raw=b.cookies.get(ACCOUNT_SESSION_COOKIE),row=sql(f,'SELECT * FROM account_sessions');assert.notEqual(raw,row.token_hash);assert.ok(!JSON.stringify(row).includes(raw));assert.equal(row.token_hash.length,64);
  const auth=await getAuthenticatedAccount(b.request('session'),f.env,f.services);assert.equal(auth.id,alice.address.toLowerCase());assert.equal(auth.sessionHash,row.token_hash);
  assert.deepEqual((await b.call('session')).body,result.body);assert.equal(Object.hasOwn(result.body.account,'sessionHash'),false);
});
test('forged signatures fail without creating an account and a remaining attempt can succeed',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(),fake=await bob.signMessage({message:c.body.message});
  await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature:fake}),401,'invalid_signature');assert.equal(count(f,'accounts'),0);assert.equal(count(f,'account_sessions'),0);
  const good=await alice.signMessage({message:c.body.message});assert.equal((await b.call('login','POST',{challengeId:c.body.challengeId,signature:good})).status,200);
});
test('signatures over modified domain, URI, chain, nonce, timestamps or address are rejected',async()=>{
  for(const mutate of [
    s=>s.replace('https://hookline.world wants','https://evil.example wants'),
    s=>s.replace('URI: https://hookline.world/','URI: https://hookline.world/other'),
    s=>s.replace('Chain ID: 8453','Chain ID: 1'),
    s=>s.replace(/Nonce: .+/,'Nonce: forged000'),
    s=>s.replace('Issued At: 2026','Issued At: 2025'),
    s=>s.replace('Expiration Time: 2026','Expiration Time: 2027'),
    s=>s.replace(alice.address,bob.address),
  ]){const f=fixture(),b=new Browser(f),c=await b.challenge();const signature=await alice.signMessage({message:mutate(c.body.message)});await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature}),401,'invalid_signature');assert.equal(count(f,'accounts'),0);}
});
test('arbitrary signed messages and client-supplied account fields are not accepted',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(),signature=await alice.signMessage({message:c.body.message});
  for(const extra of [{message:c.body.message},{address:bob.address},{accountId:bob.address},{expiresAt:'2099'}])await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature,...extra}),422,'unsupported_field');
  assert.equal(sql(f,'SELECT attempts FROM account_challenges').attempts,0);
});
test('browser binding prevents cross-browser login and duplicated cookies are rejected',async()=>{
  const f=fixture(),a=new Browser(f),other=new Browser(f),c=await a.challenge(),signature=await alice.signMessage({message:c.body.message});
  await expectCode(other.call('login','POST',{challengeId:c.body.challengeId,signature}),401,'invalid_challenge');
  await other.challenge(bob);await expectCode(other.call('login','POST',{challengeId:c.body.challengeId,signature}),401,'invalid_challenge');
  const raw=a.cookies.get(ACCOUNT_BROWSER_COOKIE);await expectCode(a.call('login','POST',{challengeId:c.body.challengeId,signature},{cookie:`${ACCOUNT_BROWSER_COOKIE}=${raw}; ${ACCOUNT_BROWSER_COOKIE}=${raw}`}),401,'invalid_challenge');assert.equal(count(f,'accounts'),0);
});
test('challenge expires at ten minutes and expiration is rechecked after verification',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(),signature=await alice.signMessage({message:c.body.message});f.clock.now+=ACCOUNT_CHALLENGE_TTL_MS;
  await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature}),401,'invalid_challenge');
  const g=fixture(),second=new Browser(g),d=await second.challenge(bob);const services={...g.services,verifySmartWalletSignature:async()=>{g.clock.now+=ACCOUNT_CHALLENGE_TTL_MS;return true;}};
  await expectCode(second.call('login','POST',{challengeId:d.body.challengeId,signature:'0x1234'},{services}),401,'expired_challenge');assert.equal(count(g,'accounts'),0);
});
test('challenge is atomically single-use under simultaneous valid logins',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(),signature=await alice.signMessage({message:c.body.message});
  const requests=Array.from({length:8},()=>b.request('login','POST',{challengeId:c.body.challengeId,signature}));
  const responses=await Promise.all(requests.map(request=>handleAccountsApi(request,f.env,f.services)));
  assert.equal(responses.filter(r=>r.status===200).length,1);assert.ok(responses.filter(r=>r.status!==200).every(r=>[401,409].includes(r.status)));assert.equal(count(f,'accounts'),1);assert.equal(count(f,'account_sessions'),1);
  const replay=await handleAccountsApi(b.request('login','POST',{challengeId:c.body.challengeId,signature}),f.env,f.services);assert.equal(replay.status,401);
});
test('five invalid signature attempts exhaust a nonce without unlimited crypto work',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(),fake=await bob.signMessage({message:c.body.message});
  for(let i=0;i<5;i++)await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature:fake}),401,'invalid_signature');
  const good=await alice.signMessage({message:c.body.message});await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature:good}),401,'invalid_challenge');assert.equal(sql(f,'SELECT attempts FROM account_challenges').attempts,5);
});
test('explicit smart-wallet verifier receives exact chain/message/hash and must return true',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(bob);let seen;
  const services={...f.services,verifySmartWalletSignature:async details=>{seen=details;return true;}};
  const result=await b.call('login','POST',{challengeId:c.body.challengeId,signature:'0x1234'},{services});assert.equal(result.status,200);assert.equal(seen.chainId,8453);assert.equal(seen.address,bob.address.toLowerCase());assert.equal(seen.message,c.body.message);assert.match(seen.hash,/^0x[0-9a-f]{64}$/);assert.ok(seen.signal instanceof AbortSignal);
  for(const answer of [false,'0x1626ba7e',1,{},null]){const g=fixture(),d=new Browser(g),e=await d.challenge(bob);await expectCode(d.call('login','POST',{challengeId:e.body.challengeId,signature:'0x1234'},{services:{...g.services,verifySmartWalletSignature:async()=>answer}}),401,'invalid_signature');}
});
test('smart-wallet verification failures fail closed and do not store raw errors',async()=>{
  const f=fixture(),b=new Browser(f),c=await b.challenge(bob);const result=await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature:'0x1234'},{services:{...f.services,verifySmartWalletSignature:async()=>{throw new Error('RPC internal secret');}}}),503,'signature_verifier_unavailable');assert.ok(!JSON.stringify(result.body).includes('RPC internal secret'));assert.equal(count(f,'accounts'),0);
});
test('only canonical HTTPS origin is accepted, including read requests and sign-in endpoints',async()=>{
  const f=fixture(),b=new Browser(f);
  for(const url of ['http://hookline.world/api/account/session','https://www.hookline.world/api/account/session','https://evil.example/api/account/session','http://localhost:3000/api/account/session'])await expectCode(b.call('session','GET',undefined,{url}),403,'invalid_origin');
  for(const headers of [{Origin:'https://evil.example'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}])await expectCode(b.call('challenge','POST',{address:alice.address,chainId:8453},{headers}),403,'invalid_origin');
  await expectCode(b.call('challenge','POST',{address:alice.address,chainId:8453},{removeHeaders:['origin']}),403,'invalid_origin');assert.equal(f.env.DB.calls,0);
});
test('sessions expire after seven days without sliding renewal or fabricated defaults',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();f.clock.now+=ACCOUNT_SESSION_TTL_MS-1;assert.equal((await b.call('session')).body.authenticated,true);f.clock.now++;assert.equal((await b.call('session')).body.authenticated,false);await expectCode(b.call('watchlists'),401,'sign_in_required');assert.equal(count(f,'accounts'),1);
});
test('logout requires same-origin CSRF and revokes just that session',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();await b.signIn();
  await expectCode(a.call('logout','POST',undefined,{noCsrf:true}),403,'invalid_csrf');assert.equal((await a.call('session')).body.authenticated,true);
  await expectCode(a.call('logout','GET'),405,'method_not_allowed');
  const otherToken=b.csrf;await expectCode(a.call('logout','POST',undefined,{headers:{'X-Hookline-CSRF':otherToken},noCsrf:true}),403,'invalid_csrf');
  const result=await a.call('logout','POST');assert.equal(result.status,200);assert.equal(a.cookies.has(ACCOUNT_SESSION_COOKIE),false);assert.equal((await b.call('session')).body.authenticated,true);assert.match(result.response.headers.get('set-cookie'),/Max-Age=0/);
});
test('logout-all revokes only the current wallet and invalidates outstanding link tokens',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f),other=new Browser(f);await a.signIn();await b.signIn();await other.signIn(bob);const link=await issueLink(b);
  await expectCode(a.call('logout-all','POST',undefined,{noCsrf:true}),403,'invalid_csrf');assert.equal((await a.call('logout-all','POST')).status,200);
  assert.equal((await b.call('session')).body.authenticated,false);assert.equal((await other.call('session')).body.authenticated,true);await rejectCode(()=>consumeTelegramLink(f.env,{...tg(),token:link},f.services),'invalid_link_token');
});
test('signing in as another wallet rotates the browser session without merging accounts',async()=>{
  const f=fixture(),a=new Browser(f);await a.signIn();const oldCookie=a.cookies.get(ACCOUNT_SESSION_COOKIE);await a.call('watchlists','PUT',{revision:0,watchlists:lists()});await a.signIn(bob);
  assert.equal((await a.call('watchlists')).body.watchlists,null);assert.equal((await a.call('session','GET',undefined,{cookie:`${ACCOUNT_SESSION_COOKIE}=${oldCookie}`})).body.authenticated,false);assert.equal(count(f,'accounts'),2);assert.equal(count(f,'account_documents'),1);
});
test('watchlists store only exact v3 metadata and normalize addresses',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();assert.deepEqual((await b.call('watchlists')).body,{ok:true,watchlists:null,revision:0,updatedAt:null});
  const saved=await b.call('watchlists','PUT',{revision:0,watchlists:lists()});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);assert.equal(saved.body.watchlists.lists[0].items[0].address,alice.address.toLowerCase());assert.equal(saved.body.updatedAt,new Date(START).toISOString());assert.deepEqual((await b.call('watchlists')).body,saved.body);
});
test('private data is wallet scoped and client account IDs cannot override the session',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();await b.signIn(bob);await a.call('watchlists','PUT',{revision:0,watchlists:lists()});assert.equal((await b.call('watchlists')).body.watchlists,null);
  await expectCode(b.call('watchlists','PUT',{revision:0,watchlists:lists(),accountId:alice.address}),422,'unsupported_field');await expectCode(b.call(`watchlists?accountId=${alice.address}`),400,'query_not_allowed');assert.equal(count(f,'account_documents'),1);
});
test('watchlist saves reject stale revisions and atomic concurrent initial saves have one winner',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();
  const one=lists(),two=lists();two.lists[0].name='Other tab';const results=await Promise.all([b.call('watchlists','PUT',{revision:0,watchlists:one}),b.call('watchlists','PUT',{revision:0,watchlists:two})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const current=(await b.call('watchlists')).body;assert.equal(current.revision,1);const stale=await expectCode(b.call('watchlists','PUT',{revision:0,watchlists:two}),409,'revision_conflict');assert.equal(stale.body.revision,1);assert.deepEqual((await b.call('watchlists')).body,current);
  const updated=await b.call('watchlists','PUT',{revision:1,watchlists:two});assert.equal(updated.body.revision,2);
});
test('preferences use website defaults and partial CAS patches preserve exact decimals and unrelated fields',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();assert.deepEqual((await b.call('preferences')).body,{ok:true,preferences:defaultAccountPreferences(),revision:0,updatedAt:null});assert.equal(count(f,'account_documents'),0);
  const precise='0.000000000000000000000000000000000001';const first=await b.call('preferences','PUT',{revision:0,patch:{buyPresets:[precise,'0.1200'],slippageBps:100}});assert.equal(first.status,200);
  const second=await b.call('preferences','PUT',{revision:1,patch:{sellPresets:[10,100]}});assert.deepEqual(second.body.preferences,{slippageBps:100,buyPresets:[precise,'0.1200'],sellPresets:[10,100]});assert.equal(second.body.revision,2);
  await expectCode(b.call('preferences','PUT',{revision:1,patch:{slippageBps:200}}),409,'revision_conflict');assert.equal((await b.call('preferences')).body.preferences.slippageBps,100);
});
test('parallel preference patches never clobber without a revision conflict',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();await b.call('preferences','PUT',{revision:0,patch:{slippageBps:100}});
  const results=await Promise.all([b.call('preferences','PUT',{revision:1,patch:{buyPresets:['0.20']}}),b.call('preferences','PUT',{revision:1,patch:{sellPresets:[10,50]}})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await b.call('preferences')).body.revision,2);
});
test('observations, wallet keys, execution authority, and prototype fields are rejected before storage',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();
  for(const field of ['evidence','observations','lastError','lastAttemptAt','privateKey','userId']){const model=lists();model.lists[0].items[0][field]='never store';await expectCode(b.call('watchlists','PUT',{revision:0,watchlists:model}),422,'unsupported_field');}
  for(const patch of [{privateKey:'never store'},{autoTrade:true},{priorityFeeGwei:'1'},{walletAddress:bob.address},{tpSlProfiles:[]},JSON.parse('{"__proto__":{"polluted":true}}')])await expectCode(b.call('preferences','PUT',{revision:0,patch}),422,'unsupported_field');assert.equal(count(f,'account_documents'),0);
});
test('stored display text rejects markup, control characters, bidi spoofing and malformed identifiers',async()=>{
  for(const value of ['<img src=x onerror=alert(1)>','bad\nline','\u202eevil',' leading','', 'x'.repeat(61)]){const m=lists();m.lists[0].name=value;assert.throws(()=>validateWatchlists(m),e=>e.code==='invalid_label');}
  for(const value of ['<script>','two words','__bad/id','x'.repeat(121)]){const m=lists();m.lists[0].items[0].id=value;assert.throws(()=>validateWatchlists(m),e=>e.code==='invalid_id');}
  const m=lists();m.lists[0].name="Alice's hooks & pools";assert.equal(validateWatchlists(m).lists[0].name,m.lists[0].name);
});
test('watchlist limits, active ID, duplicates, chain/address types and revision bounds are strict',async()=>{
  const target=i=>`0x${(i+1).toString(16).padStart(40,'0')}`;
  const m={version:3,activeListId:'l0',lists:Array.from({length:5},(_,n)=>({id:`l${n}`,name:`List ${n}`,createdAt:START,items:Array.from({length:100},(_,i)=>({id:`i${i}`,chainId:8453,address:target(i),label:null}))}))};assert.equal(validateWatchlists(m).lists.length,5);
  const excess=structuredClone(m);excess.lists.push({id:'extra',name:'Extra',createdAt:START,items:[{id:'extra',chainId:1,address:target(100),label:null}]});assert.throws(()=>validateWatchlists(excess),e=>e.code==='too_many_items');
  for(const mutate of [x=>x.lists.push({...x.lists[0]}),x=>x.activeListId='missing',x=>x.lists[0].items.push({...x.lists[0].items[0]}),x=>x.lists[0].items[0].chainId='8453',x=>x.lists[0].items[0].address='0x'+'0'.repeat(40),x=>x.lists[0].createdAt=Infinity]){const x=lists();mutate(x);assert.throws(()=>validateWatchlists(x),AccountError);}
  const f=fixture(),b=new Browser(f);await b.signIn();for(const revision of [-1,'0',1.5,null,Number.MAX_SAFE_INTEGER])await expectCode(b.call('watchlists','PUT',{revision,watchlists:lists()}),422,'invalid_revision');
});
test('preference numeric validation preserves exact strings and rejects malformed/duplicate presets',async()=>{
  for(const buyPresets of [[],['0'],['1e-3'],['.1'],['01'],[0.1],['1.'],[' 1'],['0.1','0.100'],['1','2','3','4','5','6','7'],['1'.repeat(81)]])assert.throws(()=>validatePreferencesPatch({buyPresets}),AccountError);
  for(const slippageBps of [0,5001,1.5,'50',NaN,null])assert.throws(()=>validatePreferencesPatch({slippageBps}),AccountError);
  for(const sellPresets of [[],[0],[101],[1.5],['25'],[50,50]])assert.throws(()=>validatePreferencesPatch({sellPresets}),AccountError);
  assert.deepEqual(validatePreferencesPatch({slippageBps:5000,buyPresets:['1.0000'],sellPresets:[1,100]}),{slippageBps:5000,buyPresets:['1.0000'],sellPresets:[1,100]});
});
test('body limits, content type, invalid JSON and account credentials in URLs fail safely',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();
  await expectCode(b.call('preferences','PUT',undefined,{rawBody:'x'.repeat(9000),headers:{'content-type':'application/json'}}),413,'request_too_large');
  await expectCode(b.call('watchlists','PUT',undefined,{rawBody:'x'.repeat(270000),headers:{'content-type':'application/json'}}),413,'request_too_large');
  await expectCode(b.call('preferences','PUT',undefined,{rawBody:'{}',headers:{'content-type':'text/plain'}}),415,'json_required');
  await expectCode(b.call('preferences','PUT',undefined,{rawBody:'{',headers:{'content-type':'application/json'}}),400,'invalid_json');
  await expectCode(b.call('session?token=do-not-send'),400,'query_not_allowed');assert.equal(count(f,'account_documents'),0);
  const tooBig=lists();tooBig.lists[0].name='🎣'.repeat(70000);assert.throws(()=>validateWatchlists(tooBig),e=>e.code==='data_too_large');
});
test('database and corrupt storage failures are explicit, never silent default resets',async()=>{
  const missing=fixture({migrate:false}),a=new Browser(missing);const error=await expectCode(a.call('challenge','POST',{address:alice.address,chainId:1}),503,'accounts_unavailable');assert.ok(!JSON.stringify(error.body).includes('SQLITE'));
  const f=fixture(),b=new Browser(f);await b.signIn();await b.call('preferences','PUT',{revision:0,patch:{slippageBps:100}});f.env.DB.sqlite.prepare('UPDATE account_documents SET document_json=?').run('{"privateKey":"do-not-expose"}');
  const r=await expectCode(b.call('preferences'),503,'accounts_unavailable');assert.ok(!JSON.stringify(r.body).includes('do-not-expose'));await expectCode(b.call('preferences','PUT',{revision:1,patch:{slippageBps:200}}),503,'accounts_unavailable');assert.equal(sql(f,'SELECT revision FROM account_documents').revision,1);
});
test('Telegram link issuance requires authenticated origin/CSRF and stores only a one-time hash',async()=>{
  const f=fixture(),b=new Browser(f);await expectCode(b.call('telegram-link','POST'),401,'sign_in_required');await b.signIn();await expectCode(b.call('telegram-link','POST',undefined,{noCsrf:true}),403,'invalid_csrf');
  const token=await issueLink(b),row=sql(f,'SELECT * FROM account_telegram_link_tokens');assert.equal(row.token_hash.length,64);assert.ok(!JSON.stringify(row).includes(token));assert.equal(row.expires_at-row.created_at,ACCOUNT_LINK_TTL_MS);assert.deepEqual((await b.call('telegram-link')).body,{ok:true,linked:false});
});
test('Telegram link consumption requires exact private authenticated user/chat/from identity before DB work',async()=>{
  const f=fixture();const start=f.env.DB.calls;
  for(const context of [{}, {...tg(),chatType:'group'}, {...tg(),chatId:'-12345'}, {...tg(),userId:'999'}, {...tg(),fromId:'999'}, {...tg(),userId:0}, {...tg(),userId:'012345'}, {...tg(),userId:9007199254740992}])await rejectCode(()=>consumeTelegramLink(f.env,{...context,token:'a'.repeat(43)},f.services),'private_chat_required');assert.equal(f.env.DB.calls,start);
});
test('Telegram linking requires both website token and private identity and exposes no other user data',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();await b.signIn(bob);const token=await issueLink(a);
  const result=await consumeTelegramLink(f.env,{...tg(),token},f.services);assert.equal(result.account.id,alice.address.toLowerCase());assert.equal(result.telegramUserId,'12345');
  assert.deepEqual((await a.call('telegram-link')).body,{ok:true,linked:true,telegramUserId:'12345',linkedAt:new Date(START).toISOString()});assert.deepEqual((await b.call('telegram-link')).body,{ok:true,linked:false});
  assert.equal((await getTelegramAccount(f.env,tg(),f.services)).id,alice.address.toLowerCase());assert.equal(await getTelegramAccount(f.env,tg('99999'),f.services),null);assert.equal(count(f,'account_documents'),0);
});
test('link replay, expiry, random token, replaced token and session revocation are rejected',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();const old=await issueLink(b),fresh=await issueLink(b);
  await rejectCode(()=>consumeTelegramLink(f.env,{...tg(),token:old},f.services),'invalid_link_token');await rejectCode(()=>consumeTelegramLink(f.env,{...tg(),token:'z'.repeat(43)},f.services),'invalid_link_token');
  await consumeTelegramLink(f.env,{...tg(),token:fresh},f.services);await rejectCode(()=>consumeTelegramLink(f.env,{...tg(),token:fresh},f.services),'invalid_link_token');
  const g=fixture(),d=new Browser(g);await d.signIn();const expired=await issueLink(d);g.clock.now+=ACCOUNT_LINK_TTL_MS;await rejectCode(()=>consumeTelegramLink(g.env,{...tg(),token:expired},g.services),'invalid_link_token');
  const revoked=await issueLink(d);await d.call('logout','POST');await rejectCode(()=>consumeTelegramLink(g.env,{...tg(),token:revoked},g.services),'invalid_link_token');
});
test('wallet and Telegram links are one-to-one, conflicting wallets are never merged',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();await b.signIn(bob);const first=await issueLink(a),second=await issueLink(b);
  await consumeTelegramLink(f.env,{...tg(),token:first},f.services);await rejectCode(()=>consumeTelegramLink(f.env,{...tg(),token:second},f.services),'telegram_link_conflict');await expectCode(a.call('telegram-link','POST'),409,'telegram_already_linked');assert.equal(count(f,'account_telegram_links'),1);assert.equal(sql(f,'SELECT consumed_at FROM account_telegram_link_tokens WHERE account_address=?',bob.address.toLowerCase()).consumed_at,null);
});
test('simultaneous token claims and competing wallet links cannot win twice',async()=>{
  const f=fixture(),a=new Browser(f);await a.signIn();const token=await issueLink(a);
  const results=await Promise.allSettled([consumeTelegramLink(f.env,{...tg(),token},f.services),consumeTelegramLink(f.env,{...tg('999'),token},f.services)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(count(f,'account_telegram_links'),1);
  const g=fixture(),x=new Browser(g),y=new Browser(g);await x.signIn();await y.signIn(bob);const one=await issueLink(x),two=await issueLink(y);
  const competing=await Promise.allSettled([consumeTelegramLink(g.env,{...tg(),token:one},g.services),consumeTelegramLink(g.env,{...tg(),token:two},g.services)]);assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(count(g,'account_telegram_links'),1);assert.equal(sql(g,'SELECT count(*) AS n FROM account_telegram_link_tokens WHERE consumed_at IS NOT NULL').n,1);
});
test('unlink requires CSRF, preserves private preferences, and permits explicit relinking',async()=>{
  const f=fixture(),a=new Browser(f);await a.signIn();await a.call('preferences','PUT',{revision:0,patch:{slippageBps:100}});const token=await issueLink(a);await consumeTelegramLink(f.env,{...tg(),token},f.services);
  await expectCode(a.call('telegram-link','DELETE',undefined,{noCsrf:true}),403,'invalid_csrf');assert.equal((await a.call('telegram-link','DELETE')).status,200);assert.equal(await getTelegramAccount(f.env,tg(),f.services),null);assert.equal((await a.call('preferences')).body.preferences.slippageBps,100);
  const fresh=await issueLink(a);assert.equal((await consumeTelegramLink(f.env,{...tg('999'),token:fresh},f.services)).telegramUserId,'999');
});
test('challenge rate limits are atomic, ignore spoofable forwarded headers, and bound total writes',async()=>{
  const f=fixture();const browsers=Array.from({length:40},(_,i)=>new Browser(f,{'X-Forwarded-For':`198.51.100.${i}`}));
  const results=await Promise.all(browsers.map((b,i)=>b.call('challenge','POST',{address:`0x${(i+1).toString(16).padStart(40,'0')}`,chainId:8453})));
  assert.equal(results.filter(r=>r.status===200).length,30);assert.ok(results.filter(r=>r.status!==200).every(r=>r.status===429));assert.equal(count(f,'account_challenges'),30);assert.equal(count(f,'accounts'),0);assert.ok(count(f,'account_auth_limits')<=32);
  const g=fixture(),b=new Browser(g);for(let i=0;i<10;i++)await b.challenge();await expectCode(b.call('challenge','POST',{address:alice.address,chainId:8453}),429,'rate_limited');assert.equal(count(g,'account_challenges'),10);
});
test('absence of CF IP uses a shared anonymous bucket, not user-chosen forwarded identities',async()=>{
  const f=fixture();
  for(let i=0;i<31;i++){const b=new Browser(f,{'X-Forwarded-For':`198.51.100.${i}`});const result=await b.call('challenge','POST',{address:`0x${(i+1).toString(16).padStart(40,'0')}`,chainId:8453},{removeHeaders:['cf-connecting-ip']});assert.equal(result.status,i<30?200:429);}
  assert.equal(count(f,'account_challenges'),30);
});
test('global challenge cap cannot be bypassed by new wallet addresses or IPs',async()=>{
  const f=fixture(),key=`challenge:global:${Math.floor(START/86400000)}`;f.env.DB.sqlite.prepare('INSERT INTO account_auth_limits VALUES(?,?,?)').run(key,1999,START+86400000);const a=new Browser(f);await a.challenge();const b=new Browser(f,{'CF-Connecting-IP':'203.0.113.99'});await expectCode(b.call('challenge','POST',{address:bob.address,chainId:8453}),429,'rate_limited');assert.equal(count(f,'account_challenges'),1);
});
test('active sessions are capped at ten and the newest session always survives timestamp ties',async()=>{
  const f=fixture(),browsers=[];
  for(let i=0;i<11;i++){if(i===10)f.clock.now+=3600000;const b=new Browser(f);await b.signIn();browsers.push(b);}
  assert.equal(sql(f,'SELECT count(*) AS n FROM account_sessions WHERE revoked_at IS NULL').n,10);assert.equal((await browsers.at(-1).call('session')).body.authenticated,true);assert.equal(count(f,'accounts'),1);
});
test('ephemeral cleanup is bounded and never deletes account data or active links',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();await b.call('watchlists','PUT',{revision:0,watchlists:lists()});const token=await issueLink(b);await consumeTelegramLink(f.env,{...tg(),token},f.services);
  const stmt=f.env.DB.sqlite.prepare('INSERT INTO account_auth_limits(bucket_key,hits,expires_at) VALUES(?,1,?)');for(let i=0;i<550;i++)stmt.run(`expired-${i}`,START-1);
  const result=await pruneAccountEphemera(f.env,f.services);assert.ok(result.deleted>=500);assert.equal(sql(f,"SELECT count(*) AS n FROM account_auth_limits WHERE bucket_key LIKE 'expired-%'").n,50);assert.equal(count(f,'account_documents'),1);assert.equal(count(f,'account_telegram_links'),1);assert.equal((await b.call('session')).body.authenticated,true);
});
test('invalid stored challenge invariants and unsupported chains do not authenticate',async()=>{
  const f=fixture(),b=new Browser(f);await expectCode(b.call('challenge','POST',{address:alice.address,chainId:31337}),422,'unsupported_chain');const c=await b.challenge();f.env.DB.sqlite.prepare('UPDATE account_challenges SET message=? WHERE id=?').run(c.body.message.replace('hookline.world','evil.example'),c.body.challengeId);const signature=await alice.signMessage({message:c.body.message});await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature}),503,'accounts_unavailable');assert.equal(count(f,'accounts'),0);
});
test('auth helpers enforce origin/CSRF and database failure never silently becomes guest',async()=>{
  const f=fixture(),b=new Browser(f);await b.signIn();const auth=await getAuthenticatedAccount(b.request('session'),f.env,f.services);
  assert.doesNotThrow(()=>requireAccountCsrf(b.request('preferences','PUT',{revision:0,patch:{slippageBps:100}}),auth));assert.throws(()=>requireAccountCsrf(b.request('preferences','PUT',{}, {noCsrf:true}),auth),e=>e.code==='invalid_csrf');
  const broken={DB:{prepare(){throw new Error('private SQL details');},batch(){}}};await rejectCode(()=>getAuthenticatedAccount(b.request('session'),broken,f.services),'accounts_unavailable');
});

function contractRpc(override=()=>undefined) {
  const calls=[];const block={number:'0x100',hash:`0x${'a'.repeat(64)}`};
  const rpc=async details=>{calls.push(details);const changed=await override(details,calls.length);if(changed!==undefined)return changed;
    switch(details.method){case 'eth_chainId':return '0x2105';case 'eth_getBlockByNumber':return {...block};case 'eth_getCode':return '0x6000600055';case 'eth_call':return `0x1626ba7e${'0'.repeat(56)}`;default:throw new Error('Unexpected RPC method');}
  };return {rpc,calls,block};
}
const contractInput=()=>({address:bob.address.toLowerCase(),chainId:8453,message:'A bounded test message',signature:'0x1234'});
test('EIP-1271 reader uses a fixed RPC callback, explicit chain, bounded call, and pinned block/hash',async()=>{
  const fake=contractRpc(),verify=createEip1271Verifier({rpc:fake.rpc,allowedChains:[8453]});assert.equal(await verify(contractInput()),true);
  assert.deepEqual(fake.calls.map(call=>call.method),['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getBlockByNumber']);
  const code=fake.calls.find(c=>c.method==='eth_getCode'),call=fake.calls.find(c=>c.method==='eth_call');assert.deepEqual(code.params,[bob.address.toLowerCase(),'0x100']);assert.equal(call.params[1],'0x100');assert.equal(call.params[0].to,bob.address.toLowerCase());assert.equal(call.params[0].gas,'0xf4240');assert.match(call.params[0].data,/^0x1626ba7e/);assert.ok(fake.calls.every(c=>c.chainId===8453&&c.signal instanceof AbortSignal));
});
test('EIP-1271 reader rejects unsupported chains and inconsistent digest before any RPC',async()=>{
  const fake=contractRpc(),verify=createEip1271Verifier({rpc:fake.rpc,allowedChains:[8453]});assert.equal(await verify({...contractInput(),chainId:1}),false);assert.equal(await verify({...contractInput(),hash:`0x${'0'.repeat(64)}`}),false);assert.equal(await verify({...contractInput(),address:'not-an-address'}),false);assert.equal(fake.calls.length,0);
});
test('EIP-1271 reader rejects undeployed/counterfactual wallets and nonmagic or malformed output',async()=>{
  const empty=contractRpc(({method})=>method==='eth_getCode'?'0x':undefined);assert.equal(await createEip1271Verifier({rpc:empty.rpc})(contractInput()),false);assert.equal(empty.calls.some(c=>c.method==='eth_call'),false);
  for(const value of ['0x', '0x1626ba7e',`0xffffffff${'0'.repeat(56)}`,`0x1626ba7e${'f'.repeat(56)}`,true,null]){const fake=contractRpc(({method})=>method==='eth_call'?value:undefined);assert.equal(await createEip1271Verifier({rpc:fake.rpc})(contractInput()),false);}
  const reverted=contractRpc(({method})=>{if(method==='eth_call')throw Object.assign(new Error('execution reverted'),{code:3});});assert.equal(await createEip1271Verifier({rpc:reverted.rpc})(contractInput()),false);
});
test('EIP-1271 reader fails closed on wrong chain, missing headers, reorg, RPC failure and abort',async()=>{
  for(const override of [
    ({method})=>method==='eth_chainId'?'0x1':undefined,
    ({method})=>method==='eth_getBlockByNumber'?null:undefined,
    ({method,params})=>method==='eth_getBlockByNumber'&&params[0]!=='latest'?{number:'0x100',hash:`0x${'b'.repeat(64)}`}:undefined,
    ({method})=>{if(method==='eth_call')throw new Error('RPC private service failure');},
    ({method})=>method==='eth_getCode'?'broken':undefined,
  ]){const fake=contractRpc(override);await rejectCode(()=>createEip1271Verifier({rpc:fake.rpc})(contractInput()),'signature_verifier_unavailable');}
  const controller=new AbortController();controller.abort();const fake=contractRpc();await rejectCode(()=>createEip1271Verifier({rpc:fake.rpc})({...contractInput(),signal:controller.signal}),'signature_verifier_unavailable');assert.equal(fake.calls.length,0);
});
test('EIP-1271 injected reader works end-to-end without wallet creation or transaction submission',async()=>{
  const f=fixture(),b=new Browser(f),fake=contractRpc(),challenge=await b.challenge(bob);const services={...f.services,verifySmartWalletSignature:createEip1271Verifier({rpc:fake.rpc})};
  const result=await b.call('login','POST',{challengeId:challenge.body.challengeId,signature:'0x1234'},{services});assert.equal(result.status,200);assert.equal(sql(f,'SELECT auth_method FROM accounts').auth_method,'eip1271');assert.equal(sql(f,'SELECT auth_chain_id FROM accounts').auth_chain_id,8453);assert.equal((await b.call('session')).body.authenticated,true);assert.ok(!fake.calls.some(call=>/send|transaction|estimateGas/.test(call.method)));
});
test('same smart-wallet address on a different chain cannot access the original account',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f),services={...f.services,verifySmartWalletSignature:async()=>true};
  const first=await a.challenge(bob,8453);assert.equal((await a.call('login','POST',{challengeId:first.body.challengeId,signature:'0x1234'},{services})).status,200);await a.call('watchlists','PUT',{revision:0,watchlists:lists()});
  const second=await b.challenge(bob,1);await expectCode(b.call('login','POST',{challengeId:second.body.challengeId,signature:'0x1234'},{services}),403,'account_identity_conflict');await expectCode(b.call('watchlists'),401,'sign_in_required');assert.equal(count(f,'account_sessions'),1);assert.equal(sql(f,'SELECT auth_chain_id FROM accounts').auth_chain_id,8453);
  const same=await b.challenge(bob,8453);assert.equal((await b.call('login','POST',{challengeId:same.body.challengeId,signature:'0x1234'},{services})).status,200);assert.equal((await b.call('watchlists')).body.revision,1);
});
test('EOA and smart-wallet identities cannot silently replace each other at the same address',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();const c=await b.challenge(alice);await expectCode(b.call('login','POST',{challengeId:c.body.challengeId,signature:'0x1234'},{services:{...f.services,verifySmartWalletSignature:async()=>true}}),403,'account_identity_conflict');assert.equal(sql(f,'SELECT auth_method FROM accounts').auth_method,'eoa');
  const g=fixture(),x=new Browser(g),y=new Browser(g),d=await x.challenge(alice);assert.equal((await x.call('login','POST',{challengeId:d.body.challengeId,signature:'0x1234'},{services:{...g.services,verifySmartWalletSignature:async()=>true}})).status,200);
  const e=await y.challenge(alice),signature=await alice.signMessage({message:e.body.message});await expectCode(y.call('login','POST',{challengeId:e.body.challengeId,signature}),403,'account_identity_conflict');assert.equal(sql(g,'SELECT auth_method FROM accounts').auth_method,'eip1271');
});
test('contract account identity binding is atomic under simultaneous different-chain registration',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f),services={...f.services,verifySmartWalletSignature:async()=>true};const ca=await a.challenge(bob,8453),cb=await b.challenge(bob,1);
  const results=await Promise.all([a.call('login','POST',{challengeId:ca.body.challengeId,signature:'0x1234'},{services}),b.call('login','POST',{challengeId:cb.body.challengeId,signature:'0x1234'},{services})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);assert.equal(count(f,'accounts'),1);assert.equal(count(f,'account_sessions'),1);
});
test('EOA identity legitimately remains the same across supported chains',async()=>{
  const f=fixture(),a=new Browser(f),b=new Browser(f);await a.signIn();await a.call('watchlists','PUT',{revision:0,watchlists:lists()});const c=await b.challenge(alice,1),signature=await alice.signMessage({message:c.body.message});assert.equal((await b.call('login','POST',{challengeId:c.body.challengeId,signature})).status,200);assert.equal((await b.call('watchlists')).body.revision,1);assert.equal(count(f,'accounts'),1);assert.equal(sql(f,'SELECT auth_chain_id FROM accounts').auth_chain_id,null);
});
test('database independently enforces EOA versus contract-chain binding',async()=>{
  const f=fixture();const statement=f.env.DB.sqlite.prepare('INSERT INTO accounts(address,created_at,last_login_at,auth_method,auth_chain_id) VALUES(?,?,?,?,?)');
  assert.throws(()=>statement.run(alice.address.toLowerCase(),START,START,'eip1271',null));assert.throws(()=>statement.run(alice.address.toLowerCase(),START,START,'eoa',8453));assert.equal(count(f,'accounts'),0);
});

let passed=0;
for(const [name,fn] of tests){try{await fn();passed++;console.log(`PASS ${name}`);}catch(error){console.error(`FAIL ${name}`);throw error;}}
console.log(`\n${passed} account tests passed.`);
