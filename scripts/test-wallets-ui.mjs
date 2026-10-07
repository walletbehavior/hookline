import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(){this.children=[];this.value='';this.disabled=false;this.hidden=false;this.classList={toggle(){}};}
  set textContent(value){this.text=String(value);}
  get textContent(){return this.text || '';}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const sdk=readFileSync(new URL('../wallet-client/entry.jsx',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
const document={readyState:'loading',getElementById:id=>nodes.get(id),querySelectorAll:()=>[],addEventListener(){}};
const A=`0x${'1'.repeat(40)}`,B=`0x${'2'.repeat(40)}`,HASH=`0x${'3'.repeat(64)}`;
const events=new Map(),calls=[];
let chain='0x2105',accounts=[A],receiptRequests=0;
const provider={on:(name,fn)=>events.set(name,fn),removeListener:(name)=>events.delete(name),request:async({method,params})=>{
  calls.push({method,params});
  if(method==='eth_accounts'||method==='eth_requestAccounts')return accounts;
  if(method==='eth_chainId')return chain;
  if(method==='eth_sendTransaction'){assert.equal(nodes.get('execution-dialog').open,false,'The SDK confirmation must not be covered by a native dialog.');return HASH;}
  throw new Error(`Unexpected wallet action ${method}`);
}};
const context=vm.createContext({document,window:{},ethereum:provider,URL,URLSearchParams,console,
  location:{origin:'https://hookline.world',hash:'#/board'},setTimeout:()=>0,clearTimeout(){},
  fetch:async(url,options)=>{
    assert.equal(url,'/api/execution/receipt');receiptRequests++;
    assert.deepEqual(JSON.parse(options.body),{intent_id:'hxi_pending',transaction_hash:HASH});
    return {ok:true,json:async()=>({receipt:{block_number:123}})};
  },
});
const names=['state','executionProvider','selectWalletProvider','bindExecutionProvider','hasPendingExecution','resetExecutionQuote','disconnectExecutionWallet','openExecutionDialog','requestWalletConfirmation','checkExecutionConfirmation'];
vm.runInContext(source.replace('  window.Hookline = {',`  window.__WalletTest={${names.join(',')}};\n  window.Hookline = {`),context);
const ui=context.window.__WalletTest;
await ui.selectWalletProvider({provider,address:A,embedded:true});
assert.equal(ui.state.wallets.source,'embedded');assert.equal(ui.executionProvider(),provider);
assert.equal(ui.state.execution.account,A);
assert(calls.every(call=>call.method==='eth_accounts'),'Selecting a wallet never requests a signature or transaction.');
await assert.rejects(ui.selectWalletProvider({provider,address:B}),/selection changed/);
ui.state.accountController={isBusy:()=>true};
await assert.rejects(ui.selectWalletProvider({provider,address:A}),/Finish/);
ui.state.accountController=null;

ui.state.execution.item={chainId:8453};
ui.state.execution.quote={evidence:'kept'};ui.state.execution.pendingIntentId='hxi_pending';ui.state.execution.submittedHash=HASH;
events.get('chainChanged')();events.get('accountsChanged')([B]);
assert.equal(ui.state.execution.submittedHash,HASH);assert.equal(ui.state.execution.pendingIntentId,'hxi_pending');
assert.equal(ui.state.execution.quote.evidence,'kept');assert.equal(nodes.get('execution-submit').textContent,'Check confirmation');
await assert.rejects(ui.selectWalletProvider({provider,address:A}),/Finish/);
ui.disconnectExecutionWallet();assert.equal(ui.executionProvider(),provider);
ui.openExecutionDialog({chainId:1},{});assert.equal(ui.state.execution.item.chainId,8453);
const before=calls.length;await ui.checkExecutionConfirmation();
assert.equal(receiptRequests,1);assert.equal(calls.length,before,'Receipt retry must never send a second transaction.');
assert.equal(ui.state.execution.receipt.block_number,123);assert.equal(ui.hasPendingExecution(),false);

ui.state.execution.pendingApprovalHash=HASH;ui.resetExecutionQuote();
assert.equal(ui.state.execution.pendingApprovalHash,HASH,'Pending approvals also survive resets.');
ui.state.execution.pendingApprovalHash=null;ui.resetExecutionQuote();
nodes.get('execution-dialog').showModal();accounts=[A];
assert.equal(await ui.requestWalletConfirmation(provider,{from:A,to:B,value:'0x0'}),HASH);
assert.equal(nodes.get('execution-dialog').open,true);
const sends=calls.filter(call=>call.method==='eth_sendTransaction').length;
accounts=[B];await assert.rejects(ui.requestWalletConfirmation(provider,{from:A,to:B}),/no longer connected/);
accounts=[A];chain='0x1';await assert.rejects(ui.requestWalletConfirmation(provider,{from:A,to:B}),/chain changed/);
assert.equal(calls.filter(call=>call.method==='eth_sendTransaction').length,sends);

assert.match(sdk,/createOnLogin:'off'/);assert.match(sdk,/showWalletUIs:true/);
assert.match(sdk,/exportWallet\(\{address:wallet.address\}\)/);
assert.doesNotMatch(sdk,/getWalletPrivateKey|useSessionSigners|addSessionSigner|privateKey:/);
assert.match(sdk,/onComplete:/);assert.match(sdk,/onError:/);
assert(!html.includes('<script src="privy-wallet.js"'),'SDK must load only after a wallet action.');
console.log('Wallet UI: explicit selection, wrong-account/chain rejection, confirmation visibility, pending-receipt preservation, no-resubmit retry and secure SDK configuration passed.');
