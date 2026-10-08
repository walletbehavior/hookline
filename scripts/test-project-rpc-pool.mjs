import assert from 'node:assert/strict';
import {PROJECT_RPC_POOLS,createRpcPoolHealth,createProjectRpcPool,classifyProjectRpcFailure} from '../projects/rpc-pool.js';

const hex=n=>`0x${BigInt(n).toString(16)}`;
const hash=n=>`0x${BigInt(n).toString(16).padStart(64,'0')}`;
const address=`0x${'1'.repeat(40)}`;
const head={number:hex(10000),hash:hash(10000),timestamp:hex(1780000000)};
const filter=width=>({address,fromBlock:hex(10001-width),toBlock:head.number,topics:[[hash(1)]]});
const reply=(request,result,{status=200,message,code=-32000,headers={},id=request.id}={})=>new Response(JSON.stringify({jsonrpc:'2.0',id,...(message?{error:{code,message}}:{result})}),{status,headers});
const chain=url=>url.includes('robinhood')?4663:url.includes('base.')||url.includes('base-')?8453:url.includes('arbitrum')||url.includes('arb1.')?42161:url.includes('bsc-')?56:1;
function harness({handler,health=createRpcPoolHealth(),maxRequests=240,time=1780000000000,deadlineMs=42000}={}) {
  let clock=time;const calls=[];
  const fetchImpl=async(url,options)=>{
    const request=JSON.parse(options.body);calls.push({url,...request,time:clock});
    const custom=await handler?.({url,request,options,advance:ms=>{clock+=ms;}});if(custom) return custom;
    if(request.method==='eth_chainId') return reply(request,hex(chain(url)));
    if(request.method==='eth_blockNumber') return reply(request,head.number);
    if(request.method==='eth_getBlockByNumber') return reply(request,{...head,number:request.params[0]==='finalized'?head.number:request.params[0]});
    if(request.method==='eth_getCode') return reply(request,'0x6001');
    if(request.method==='eth_getStorageAt') return reply(request,hash(0));
    if(request.method==='eth_call') return reply(request,hash(0));
    if(request.method==='eth_getLogs') return reply(request,[]);
    if(request.method==='eth_getTransactionReceipt') return reply(request,null);
    throw new Error(`Unhandled method ${request.method}`);
  };
  const pool=createProjectRpcPool({health,fetchImpl,now:()=>clock,sleep:async ms=>{clock+=ms;},maxRequests,deadlineAt:clock+deadlineMs});
  return {...pool,calls,health,advance:ms=>{clock+=ms;},time:()=>clock};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('immutable method-specific sources exclude known unusable log services',()=>{
  assert.ok(Object.isFrozen(PROJECT_RPC_POOLS));assert.ok(Object.isFrozen(PROJECT_RPC_POOLS[1].logs));
  assert.throws(()=>PROJECT_RPC_POOLS[4663].logs.push({url:'https://untrusted.example'}));
  assert.deepEqual(PROJECT_RPC_POOLS[4663].logs.map(p=>p.id),['robinhood-official']);
  assert.ok(PROJECT_RPC_POOLS[56].logs.every(p=>p.id!=='bnb-official'));
  assert.ok(PROJECT_RPC_POOLS[8453].state.every(p=>p.id!=='base-publicnode'));
  assert.deepEqual(PROJECT_RPC_POOLS[8453].state.map(p=>p.id),['base-tenderly','base-official','base-drpc']);
  for(const config of Object.values(PROJECT_RPC_POOLS)) for(const providers of Object.values(config)) for(const entry of providers) {
    assert.match(entry.url,/^https:\/\//);assert.match(entry.sourceUrl,/^https:\/\//);assert.equal(new URL(entry.url).username,'');
  }
});
test('writes, arbitrary chains, unpinned state, and broad/unbounded logs fail before network',async()=>{
  const h=harness();
  await assert.rejects(h.rpc(1,'eth_sendRawTransaction',['0x12']),/rpc_method_forbidden/);
  await assert.rejects(h.rpc(999,'eth_chainId',[]),/rpc_method_forbidden/);
  await assert.rejects(h.rpc(1,'eth_getCode',[address,'latest']),/rpc_invalid_block/);
  await assert.rejects(h.rpc(1,'eth_getCode',[address,head.number]),/rpc_pin_required/);
  await assert.rejects(h.rpc(1,'eth_getLogs',[filter(2)]),/rpc_log_request_invalid/);
  h.rpc.pinBlock(1,head);
  await assert.rejects(h.rpc(1,'eth_getLogs',[filter(8001)]),/rpc_log_request_invalid/);
  await assert.rejects(h.rpc(1,'eth_getLogs',[{...filter(2),address:undefined}]),/rpc_log_request_invalid/);
  assert.equal(h.calls.length,0);
});
test('all state fallbacks verify chain and the same finalized hash before unchanged pinned reads',async()=>{
  const h=harness({handler:({url,request})=>request.method==='eth_getCode' && url.includes('tenderly')
    ?reply(request,null,{status:403,message:'historical archive access requires personal token'}):null});
  const finalized=await h.rpc(8453,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(8453,finalized);
  assert.equal(await h.rpc(8453,'eth_getCode',[address,head.number]),'0x6001');
  const state=h.calls.filter(c=>c.method==='eth_getCode');assert.equal(state.length,2);assert.deepEqual(state[0].params,state[1].params);
  for(const call of state) {
    const preceding=h.calls.slice(0,h.calls.indexOf(call));
    assert.ok(preceding.some(c=>c.url===call.url && c.method==='eth_chainId'));
    assert.ok(preceding.some(c=>c.url===call.url && c.method==='eth_getBlockByNumber' && c.params[0]===head.number));
  }
  assert.ok(h.calls.every(c=>!c.params.includes('latest')));assert.equal(h.diagnostics().requests,h.calls.length);
  assert.ok(new Set(h.calls.map(c=>c.id)).size===h.calls.length,'Every upstream request has a fresh id');
});
test('Base receipt reads reach the bounded official fallback when a free gateway is throttled',async()=>{
  const transaction=hash(77),receipt={transactionHash:transaction,blockHash:head.hash,blockNumber:head.number,logs:[],status:'0x1'};
  const h=harness({handler:({url,request})=>{
    if(request.method==='eth_getTransactionReceipt' && url.includes('tenderly')) return reply(request,null,{status:429,message:'rate limited'});
    if(request.method==='eth_getTransactionReceipt' && url.includes('mainnet.base.org')) return reply(request,receipt);
  }});h.rpc.pinBlock(8453,head);
  assert.deepEqual(await h.rpc(8453,'eth_getTransactionReceipt',[transaction]),receipt);
  assert.deepEqual(h.calls.filter(call=>call.method==='eth_getTransactionReceipt').map(call=>new URL(call.url).hostname),
    ['base.gateway.tenderly.co','mainnet.base.org']);
});
test('wrong chain and mismatched pinned hash cannot reach a state read',async()=>{
  const h=harness({handler:({url,request})=>{
    if(url.includes('tenderly') && request.method==='eth_chainId') return reply(request,hex(1));
    if(url.includes('mainnet.base.org') && request.method==='eth_getBlockByNumber') return reply(request,{...head,hash:hash(999)});
    if(url.includes('drpc') && request.method==='eth_getBlockByNumber') return reply(request,{...head,hash:hash(999)});
  }});h.rpc.pinBlock(8453,head);
  await assert.rejects(h.rpc(8453,'eth_getCode',[address,head.number]),/rpc_pin_mismatch|rpc_chain_mismatch/);
  assert.equal(h.calls.filter(c=>c.method==='eth_getCode').length,0);
});
test('pinned source headers are reread and changing hashes are never returned as canonical',async()=>{
  let changed=false;
  const h=harness({handler:({request})=>changed && request.method==='eth_getBlockByNumber'?reply(request,{...head,hash:hash(999)}):null});
  const block=await h.rpc(1,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(1,block);changed=true;
  await assert.rejects(h.rpc(1,'eth_getBlockByNumber',[head.number,false]),/rpc_pin_mismatch/);
  assert.throws(()=>h.rpc.pinBlock(1,{...head,hash:hash(3)}),/rpc_pin_changed/);
});
test('historical event headers from a fallback are anchored to the same pinned head first',async()=>{
  const h=harness({handler:({url,request})=>{
    if(url.includes('publicnode') && request.method==='eth_getBlockByNumber' && request.params[0]===hex(9990)) return reply(request,null,{status:429,message:'Too many requests'});
    if(url.includes('drpc') && request.method==='eth_getBlockByNumber' && request.params[0]===head.number) return reply(request,{...head,hash:hash(9000)});
  }});
  const block=await h.rpc(1,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(1,block);
  await assert.rejects(h.rpc(1,'eth_getBlockByNumber',[hex(9990),false]),/rpc_rate_limited|rpc_pin_mismatch/);
  assert.equal(h.calls.filter(call=>call.url.includes('drpc') && call.method==='eth_getBlockByNumber' && call.params[0]===hex(9990)).length,0);
});
test('429 honors Retry-After, cools all methods, and never learns a smaller log range',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getLogs'?reply(request,null,{status:429,message:'rate limited',headers:{'Retry-After':'120'}}):null});
  const block=await h.rpc(4663,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(4663,block);
  await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(8000)]),/rpc_rate_limited/);
  const count=h.calls.length;await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(8000)]),/rpc_rate_limited/);assert.equal(h.calls.length,count);
  assert.equal(h.rpc.suggestedLogRange(4663,8000),8000);
  const cooldown=h.health.get('robinhood-official:all');assert.ok(cooldown.cooldownUntil>=h.time()+120000);
  assert.equal(h.health.get('robinhood-official:logs').safeLogRange,null);
  assert.equal(h.health.get('robinhood-official:logs').pendingLogRange,null);
});
test('a rate limit plus a misleading alternate range error remains a rate limit, not a half-window retry',async()=>{
  const h=harness({handler:({url,request})=>request.method==='eth_getLogs'?reply(request,null,url.includes('publicnode')
    ?{status:429,message:'Too many requests'}:{status:400,code:35,message:'ranges over 10000 blocks are not supported on the free plan'}):null});
  const block=await h.rpc(1,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(1,block);
  await assert.rejects(h.rpc(1,'eth_getLogs',[filter(2000)]),/rpc_rate_limited/);
  assert.deepEqual(h.calls.filter(c=>c.method==='eth_getLogs').map(c=>c.params[0]),[filter(2000),filter(2000)]);
  assert.equal(h.health.get('ethereum-drpc:logs').safeLogRange,null);
});
test('explicit legitimate range limits are learned only after a successful bounded query',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getLogs' && Number(BigInt(request.params[0].toBlock)-BigInt(request.params[0].fromBlock)+1n)>500
    ?reply(request,null,{status:400,message:'block range limited to 500 blocks'}):null});
  const block=await h.rpc(4663,'eth_getBlockByNumber',['finalized',false]);h.rpc.pinBlock(4663,block);
  await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(8000)]),error=>error.code==='rpc_log_range_limited' && error.suggestedRange===500);
  assert.equal(h.health.get('robinhood-official:logs').safeLogRange,null);
  assert.equal(h.rpc.suggestedLogRange(4663,8000),500);
  assert.deepEqual(await h.rpc(4663,'eth_getLogs',[filter(500)]),[]);
  assert.equal(h.health.get('robinhood-official:logs').safeLogRange,500);
  assert.equal(h.health.get('robinhood-official:logs').pendingLogRange,null);
});
test('nonsensical 10000-block errors for small requests mark capability unavailable without halving',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getLogs'?reply(request,null,{status:400,code:35,message:'ranges over 10000 blocks not supported'}):null});
  h.rpc.pinBlock(4663,head);
  await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(480)]),/rpc_log_capability_unavailable/);
  const count=h.calls.length;await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(480)]),/rpc_log_capability_unavailable/);assert.equal(h.calls.length,count);
  assert.equal(h.rpc.suggestedLogRange(4663,8000),8000);
});
test('transient failures back off without reclassifying them as log density',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getLogs'?reply(request,null,{status:503,message:'temporarily unavailable'}):null});
  h.rpc.pinBlock(4663,head);
  await assert.rejects(h.rpc(4663,'eth_getLogs',[filter(8000)]),/rpc_provider_unavailable/);
  assert.equal(h.health.get('robinhood-official:logs').pendingLogRange,null);
  assert.ok(h.health.get('robinhood-official:logs').cooldownUntil>h.time());
});
test('only explicit unsupported finality allows the caller to choose a labeled confirmation-depth fallback',async()=>{
  assert.equal(classifyProjectRpcFailure({method:'eth_getBlockByNumber',message:'finalized block tag is not supported'}).code,'rpc_finality_unsupported');
  assert.equal(classifyProjectRpcFailure({method:'eth_getBlockByNumber',message:'429 Too many requests',status:429}).code,'rpc_rate_limited');
  const h=harness({handler:({request})=>request.method==='eth_getBlockByNumber'?reply(request,null):null});
  await assert.rejects(h.rpc(1,'eth_getBlockByNumber',['finalized',false]),/rpc_header_unavailable/);
  assert.ok(h.calls.every(c=>c.method!=='eth_blockNumber'));
});
test('upstream budget counts chain checks and hash verification, not just logical calls',async()=>{
  const h=harness({maxRequests:2});h.rpc.pinBlock(4663,head);
  await assert.rejects(h.rpc(4663,'eth_getCode',[address,head.number]),/scan_rpc_budget/);
  assert.equal(h.calls.length,2);assert.equal(h.diagnostics().requests,2);assert.equal(h.diagnostics().budgetReached,true);
  await assert.rejects(h.rpc(4663,'eth_getCode',[address,head.number]),/scan_rpc_budget/);assert.equal(h.calls.length,2);
});
test('unsupported finalized tags do not cool down the numbered headers used for an explicit depth fallback',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getBlockByNumber' && request.params[0]==='finalized'
    ?reply(request,null,{code:-32602,message:'finalized block tag is not supported'}):null});
  await assert.rejects(h.rpc(1,'eth_getBlockByNumber',['finalized',false]),/rpc_finality_unsupported/);
  assert.equal(await h.rpc(1,'eth_blockNumber',[]),head.number);
  const block=await h.rpc(1,'eth_getBlockByNumber',[hex(9988),false]);assert.equal(block.number,hex(9988));
  const count=h.calls.length;await assert.rejects(h.rpc(1,'eth_getBlockByNumber',['finalized',false]),/rpc_finality_unsupported/);assert.equal(h.calls.length,count);
});
test('deadline bounds pacing and calls, even if the requested budget is larger',async()=>{
  const h=harness({deadlineMs:100});await h.rpc(4663,'eth_chainId',[]);
  await assert.rejects(h.rpc(4663,'eth_getBlockByNumber',['finalized',false]),/scan_deadline/);
  assert.equal(h.calls.length,1);
  const later=harness({deadlineMs:100,handler:({request,advance})=>{advance(101);return reply(request,hex(4663));}});
  await assert.rejects(later.rpc(4663,'eth_chainId',[]),/scan_deadline/);
});
test('failed eth_call is unavailable contract data, not grounds for provider retry or quarantine',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_call'?reply(request,null,{code:3,message:'execution reverted'}):null});h.rpc.pinBlock(1,head);
  await assert.rejects(h.rpc(1,'eth_call',[{to:address,data:'0x8da5cb5b'},head.number]),/rpc_execution_reverted/);
  assert.equal(h.calls.filter(c=>c.method==='eth_call').length,1);assert.equal(h.diagnostics().failures.length,0);
});
test('JSON-RPC response ids are bound and raw provider messages never enter diagnostics',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getCode'?reply(request,'0x6001',{id:'wrong-id'}):null});h.rpc.pinBlock(1,head);
  await assert.rejects(h.rpc(1,'eth_getCode',[address,head.number]),/rpc_response_invalid/);
  assert.ok(h.diagnostics().failures.every(f=>f.code==='rpc_response_invalid'));
  assert.ok(!JSON.stringify(h.diagnostics()).includes('https://'));
});
test('receipt reads require a pin and reject a receipt from another transaction or above the finalized head',async()=>{
  const h=harness({handler:({request})=>request.method==='eth_getTransactionReceipt'?reply(request,{transactionHash:request.params[0],blockHash:hash(2),blockNumber:hex(10001),logs:[],status:'0x1'}):null});
  await assert.rejects(h.rpc(1,'eth_getTransactionReceipt',[hash(7)]),/rpc_receipt_request_invalid/);h.rpc.pinBlock(1,head);
  await assert.rejects(h.rpc(1,'eth_getTransactionReceipt',[hash(7)]),/rpc_receipt_mismatch/);
});
test('shared warm-isolate cooldown prevents a fresh scan from immediately retrying the same source',async()=>{
  const health=createRpcPoolHealth();const handler=({request})=>request.method==='eth_getLogs'?reply(request,null,{status:429,message:'rate limit',headers:{'retry-after':'60'}}):null;
  const first=harness({health,handler});first.rpc.pinBlock(4663,head);await assert.rejects(first.rpc(4663,'eth_getLogs',[filter(10)]),/rpc_rate_limited/);
  const second=harness({health,handler,time:first.time()+100});second.rpc.pinBlock(4663,head);await assert.rejects(second.rpc(4663,'eth_getLogs',[filter(10)]),/rpc_rate_limited/);
  assert.equal(second.calls.length,0);
});

let passed=0;
for(const [name,fn] of tests) {
  try {await fn();passed++;console.log(`PASS ${name}`);} catch(error) {console.error(`FAIL ${name}\n${error.stack}`);process.exitCode=1;}
}
console.log(`\n${passed}/${tests.length} ingestion RPC pool tests passed.`);
