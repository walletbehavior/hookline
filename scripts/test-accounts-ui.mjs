import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountAccounts,watchlistMetadata,restoreWatchlistMetadata} from '../dist/accounts-ui.js';

const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40);
const local={version:3,activeListId:'one',lists:[{id:'one',name:'My hooks',createdAt:1,items:[
  {id:'a',chainId:8453,address:A,label:'Alpha',evidence:{codeByteLength:2},observations:[{block:4}],lastError:null,lastAttemptAt:4},
]}]};
const metadata=watchlistMetadata(local);
assert.deepEqual(Object.keys(metadata.lists[0].items[0]),['id','chainId','address','label']);
assert(!JSON.stringify(metadata).includes('observations'));
const remote={version:3,activeListId:'two',lists:[{id:'two',name:'Cloud',createdAt:2,items:[
  {id:'b',chainId:8453,address:A,label:'Renamed',evidence:{fake:true}},
  {id:'c',chainId:1,address:A,label:'Other chain',observations:[{fake:true}]},
]}]};
const restored=restoreWatchlistMetadata(remote,local);
assert.deepEqual(restored.lists[0].items[0].evidence,{codeByteLength:2});
assert.equal(restored.lists[0].items[0].label,'Renamed');
assert.equal(restored.lists[0].items[1].evidence,null);
assert.deepEqual(restored.lists[0].items[1].observations,[]);
assert.equal(local.lists[0].name,'My hooks');

class Element {
  constructor(){this.handlers={};this.hidden=false;this.disabled=false;this.textContent='';this.classList={toggle(){}};}
  addEventListener(name,fn){this.handlers[name]=fn;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  click(){this.handlers.click?.();}
  removeAttribute(name){delete this[name];}
}
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
globalThis.document={getElementById:id=>nodes.get(id),createElement:()=>new Element()};
const storage=new Map();globalThis.localStorage={setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)||null,removeItem:key=>storage.delete(key)};
const prefs={slippageBps:50,buyPresets:['0.01'],sellPresets:[100]};
let signed=false,model=structuredClone(local),walletCalls=[],requests=[],conflict=false,cleared=false,bridgeBusy=false;
globalThis.fetch=async(path,options)=>{
  requests.push({path,options});
  assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
  let body={ok:true};let status=200;
  if(path.endsWith('/session')) body={...body,authenticated:signed,...(signed?{account:{address:A},csrfToken:'csrf'}:{})};
  else if(path.endsWith('/challenge')) body={...body,challengeId:'challenge',domain:'hookline.world',uri:'https://hookline.world/',chainId:8453,message:`https://hookline.world wants you to sign in with your Ethereum account:\n${A}\n\nSign in.`};
  else if(path.endsWith('/login')) {signed=true;body={...body,authenticated:true};}
  else if(path.endsWith('/watchlists')) {
    if(options.method==='PUT') {
      assert.equal(options.headers['X-Hookline-CSRF'],'csrf');
      const submitted=JSON.parse(options.body);assert.equal(submitted.revision,7);
      assert.deepEqual(submitted.watchlists,metadata);
      if(conflict){status=409;body={ok:false,error:{code:'revision_conflict'}};}
      else body={...body,revision:8,watchlists:metadata};
    } else body={...body,revision:7,watchlists:watchlistMetadata(remote)};
  } else if(path.endsWith('/preferences')) body={...body,revision:3,preferences:prefs};
  else if(path.endsWith('/telegram-link')) body=options.method==='POST'?{...body,token:'a'.repeat(43)}:{...body,linked:false};
  else if(path.endsWith('/logout') || path.endsWith('/logout-all')) signed=false;
  else throw new Error(`Unexpected endpoint ${path}`);
  return {ok:status===200,status,json:async()=>body};
};
const provider={request:async({method,params})=>{
  walletCalls.push({method,params});
  if(method==='eth_chainId')return '0x2105';
  if(method==='eth_accounts')return [A];
  if(method==='personal_sign'){assert(params[0].startsWith('0x'));assert.equal(params[1],A);return '0x'+'a'.repeat(130);}
  throw new Error(`Unexpected wallet method ${method}`);
}};
const bridge={getWatchlists:()=>model,setWatchlists:value=>{model=value;},getPreferences:()=>prefs,setPreferences(){},isBusy:()=>bridgeBusy,
  connectWallet:async()=>{walletCalls.push({method:'connect'});return {provider,account:A};},clearDevice:()=>{cleared=true;}};
mountAccounts(bridge);
const settle=async()=>{for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));};
await settle();
assert.equal(walletCalls.length,0,'Page load must never ask for wallet authority.');
nodes.get('top-account').click();await settle();
assert.equal(nodes.get('account-dialog').open,true);assert.equal(walletCalls.length,0);
bridgeBusy=true;nodes.get('account-signin').click();await settle();
assert.equal(walletCalls.length,0,'Sign-in must not overlap a pending trade or inspection.');
bridgeBusy=false;
nodes.get('account-signin').click();await settle();
assert.equal(signed,true);assert.equal(nodes.get('account-data-section').hidden,false);
assert(walletCalls.every(call=>!call.method.includes('send') && !call.method.includes('Permissions')));
assert(!requests.some(request=>request.options.method==='PUT'),'Sign-in does not overwrite any copy.');
conflict=true;nodes.get('account-save-lists').click();await settle();
assert.match(nodes.get('account-status').textContent,/changed in another/);
assert.equal(requests.filter(request=>request.options.method==='PUT').length,1,'A conflict is not silently retried.');
nodes.get('account-load-lists').click();await settle();
assert.equal(model.lists[0].name,'Cloud');
assert(storage.has('hookline:watchlists:before-account-load'));
assert.deepEqual(model.lists[0].items[0].evidence,{codeByteLength:2});
nodes.get('account-telegram-link').click();await settle();
assert.match(nodes.get('account-telegram-open').href,/^https:\/\/t.me\/HooklineTradeBot\?start=account_/);
nodes.get('account-signout').click();await settle();
assert.equal(nodes.get('account-data-section').hidden,true);assert.equal(cleared,false);
assert.equal(nodes.get('account-telegram-open').href,undefined,'Sign-out removes private linking capability.');
nodes.get('account-clear-device').click();assert.equal(cleared,false);
bridgeBusy=true;nodes.get('account-clear-confirm-button').click();await settle();assert.equal(cleared,false);
bridgeBusy=false;
nodes.get('account-clear-confirm-button').click();await settle();assert.equal(cleared,true);
assert.equal(storage.size,0);
// Duplicate same-chain records preserve newest evidence, not longest history.
const duplicate=structuredClone(local);duplicate.lists[0].items[0].observations=[{block:1,observedAt:1},{block:2,observedAt:2}];
duplicate.lists.push({id:'newer',name:'Newer',createdAt:3,items:[{...local.lists[0].items[0],evidence:{runtimeFingerprint:'new'},observations:[{block:3,observedAt:3}]}]});
const merged=restoreWatchlistMetadata(remote,duplicate).lists[0].items[0];
assert.equal(merged.evidence.runtimeFingerprint,'new');assert.deepEqual(merged.observations.map(x=>x.block),[1,2,3]);
// A late page-load session must never relabel freshly loaded account data.
const realFetch=globalThis.fetch;let releaseInitial;
globalThis.fetch=(path,options)=>{
  globalThis.fetch=realFetch;
  return new Promise(resolve=>{releaseInitial=()=>resolve({ok:true,status:200,json:async()=>({ok:true,authenticated:true,account:{address:B},csrfToken:'old'})});});
};
signed=false;const accountController=mountAccounts(bridge);
nodes.get('account-signin').click();await settle();
assert.equal(nodes.get('account-identity').textContent,A);
releaseInitial();await settle();
assert.equal(nodes.get('account-identity').textContent,A,'Initial session cannot overwrite a newer login.');
await accountController.signOutMatching([B]);assert.equal(signed,true,'Wallet logout must not revoke an unrelated external-wallet session.');
await accountController.signOutMatching([A]);assert.equal(signed,false,'Wallet logout revokes its matching Hookline account session.');
assert.equal(nodes.get('account-data-section').hidden,true);
const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const connector=app.slice(app.indexOf('async function connectAccountWallet()'),app.indexOf('async function switchExecutionWallet()'));
assert(!connector.includes('resetExecutionQuote'));assert(app.includes('state.pendingLocalReads>0 || state.boardLoading.size>0'));
console.log('✓ Account UI: explicit sync, source separation, no silent signatures, conflicts, private links and device privacy');
