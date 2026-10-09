import assert from 'node:assert/strict';
import {
  ADAPTER_MAX_RESPONSE_BYTES,
  BASE_POOL_MANAGER,
  ENVIO_ENDPOINT,
  ENVIO_RATE_LIMIT_PER_MINUTE,
  SQD_ENDPOINT,
  createBaseTapeAdapter,
} from '../worker/base-tape-adapter.js';

const SWAP_TOPIC='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const hash=(number)=>`0x${BigInt(number).toString(16).padStart(64,'0')}`;
const PIN={number:'0x14',hash:hash(20)};
const filter=(from=10,to=11)=>({
  address:BASE_POOL_MANAGER,
  topics:[SWAP_TOPIC],
  fromBlock:`0x${from.toString(16)}`,
  toBlock:`0x${to.toString(16)}`,
});

function sourceLog(block,logIndex=0,overrides={}) {
  return {
    block_number:block,
    block_hash:hash(block),
    transaction_hash:hash(block*100+logIndex+1),
    transaction_index:0,
    log_index:logIndex,
    address:BASE_POOL_MANAGER,
    data:'0x00',
    topic0:SWAP_TOPIC,
    topic1:hash(1),
    ...overrides,
  };
}

function envioPayload(to,logs=[],overrides={}) {
  return {archive_height:1_000,next_block:to+1,data:[{logs}],...overrides};
}

function sqdLine(block,logs=[],hashOverride=hash(block)) {
  return JSON.stringify({
    header:{number:block,hash:hashOverride},
    logs:logs.map((log)=>({
      address:log.address,
      topics:[log.topic0,log.topic1].filter(Boolean),
      data:log.data,
      logIndex:log.log_index,
      transactionIndex:log.transaction_index,
      transactionHash:log.transaction_hash,
    })),
  });
}

function sqdRange(from,to,logs=[]) {
  const byBlock=new Map();
  for(const log of logs) {
    const group=byBlock.get(log.block_number)||[];
    group.push(log);byBlock.set(log.block_number,group);
  }
  return Array.from({length:to-from+1},(_,offset)=>sqdLine(from+offset,byBlock.get(from+offset)||[])).join('\n');
}

function response(value,init={}) {
  return new Response(typeof value==='string'?value:JSON.stringify(value),init);
}

function makePool({logs=[]}={}) {
  const calls=[];let pinned=null;
  const rpc=async(chainId,method,params)=>{
    calls.push({chainId,method,params});
    if(method==='eth_getLogs') return logs;
    if(method==='eth_getBlockByNumber') return PIN;
    throw new Error(`unexpected ${method}`);
  };
  rpc.pinBlock=(chainId,block)=>{pinned={chainId,block};};
  rpc.upstreamRequests=()=>7;
  rpc.suggestedLogRange=(_chainId,cap)=>Math.min(75,cap);
  return {rpc,calls,get pinned(){return pinned;}};
}

function adapter({fetchImpl,env={ENVIO_API_TOKEN:'secret'},pool=makePool(),now=()=>1_000}={}) {
  return {pool,rpc:createBaseTapeAdapter({
    env,poolRpc:pool.rpc,fetchImpl,now,rateState:{envioRequestTimes:[]},
  })};
}

async function pin(rpc,block=PIN) { rpc.pinBlock(8453,block); }

const tests=[];
const test=(name,fn)=>tests.push([name,fn]);

test('Envio is primary and normalizes the live HyperSync response shape',async()=>{
  let request;
  const {rpc,pool}=adapter({fetchImpl:async(url,options)=>{
    assert.equal(url,ENVIO_ENDPOINT);request={options,body:JSON.parse(options.body)};
    return response(envioPayload(11,[sourceLog(10),sourceLog(11,1)]));
  }});
  await pin(rpc);
  const logs=await rpc(8453,'eth_getLogs',[filter()]);
  assert.equal(logs.length,2);assert.equal(logs[0].blockNumber,'0xa');assert.equal(logs[1].logIndex,'0x1');
  assert.equal(logs[0].removed,false);assert.equal(logs[0].blockHash,hash(10));
  assert.equal(request.options.headers.Authorization,'Bearer secret');
  assert.equal(request.body.from_block,10);assert.equal(request.body.to_block,12);
  assert.deepEqual(request.body.logs[0].address,[BASE_POOL_MANAGER]);
  assert.deepEqual(request.body.logs[0].topics,[[SWAP_TOPIC]]);
  assert.ok(request.body.field_selection.log.includes('transaction_hash'));
  assert.equal(pool.calls.length,0,'log query did not touch RPC fallback');
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'envio');
});

test('an incomplete Envio result falls through to exact SQD coverage',async()=>{
  const calls=[];
  const {rpc}=adapter({fetchImpl:async(url,options)=>{
    calls.push(url);
    if(url===ENVIO_ENDPOINT) return response(envioPayload(11,[],{next_block:11}));
    const body=JSON.parse(options.body);
    assert.equal(url,SQD_ENDPOINT);assert.equal(body.includeAllBlocks,true);
    assert.deepEqual(body.logs[0].address,[BASE_POOL_MANAGER]);
    assert.deepEqual(body.logs[0].topic0,[SWAP_TOPIC]);
    return response(sqdRange(10,11,[sourceLog(11)]));
  }});
  await pin(rpc);
  const logs=await rpc(8453,'eth_getLogs',[filter()]);
  assert.equal(logs.length,1);assert.equal(logs[0].blockNumber,'0xb');
  assert.deepEqual(calls,[ENVIO_ENDPOINT,SQD_ENDPOINT]);
  const status=rpc.tapeSourceDiagnostics();
  assert.equal(status.envio.lastFailure,'envio_range_incomplete');assert.equal(status.lastLogSource,'sqd');
});

test('SQD is the keyless primary path when no Envio token is configured',async()=>{
  const {rpc}=adapter({env:{},fetchImpl:async(url)=>{
    assert.equal(url,SQD_ENDPOINT);return response(sqdRange(10,11,[sourceLog(10)]));
  }});
  await pin(rpc);
  const logs=await rpc(8453,'eth_getLogs',[filter()]);
  assert.equal(logs.length,1);assert.equal(rpc.tapeSourceDiagnostics().envio.attempts,0);
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'sqd');
});

test('SQD resumes a partial Portal page without gaps or duplicate blocks',async()=>{
  const starts=[];
  const {rpc}=adapter({env:{},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);starts.push(body.fromBlock);
    return body.fromBlock===10
      ? response(sqdRange(10,10,[sourceLog(10)]))
      : response(sqdRange(11,11,[sourceLog(11)]));
  }});
  await pin(rpc);
  const logs=await rpc(8453,'eth_getLogs',[filter()]);
  assert.deepEqual(starts,[10,11]);assert.equal(logs.length,2);
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'sqd');
});

test('noncontiguous SQD coverage is rejected and falls back to reviewed RPC',async()=>{
  const pool=makePool({logs:[{fallback:true}]});
  const {rpc}=adapter({pool,env:{},fetchImpl:async()=>response(sqdLine(10))});
  await pin(rpc);
  assert.deepEqual(await rpc(8453,'eth_getLogs',[filter()]),[{fallback:true}]);
  assert.equal(rpc.tapeSourceDiagnostics().sqd.lastFailure,'sqd_range_noncontiguous');
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'rpc');
});

test('a source address or topic anomaly is never accepted',async()=>{
  const pool=makePool({logs:[]});
  const bad=sourceLog(10,0,{address:'0x1111111111111111111111111111111111111111'});
  const {rpc}=adapter({pool,fetchImpl:async(url)=>{
    if(url===ENVIO_ENDPOINT) return response(envioPayload(10,[bad]));
    return response('unavailable',{status:503});
  }});
  await pin(rpc);
  assert.deepEqual(await rpc(8453,'eth_getLogs',[filter(10,10)]),[]);
  assert.equal(rpc.tapeSourceDiagnostics().envio.lastFailure,'tape_source_log_address_invalid');
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'rpc');
});

test('duplicate Envio identities are rejected before SQD fallback',async()=>{
  const duplicate=sourceLog(10);
  const {rpc}=adapter({fetchImpl:async(url)=>url===ENVIO_ENDPOINT
    ? response(envioPayload(10,[duplicate,duplicate]))
    : response(sqdRange(10,10))});
  await pin(rpc);
  assert.deepEqual(await rpc(8453,'eth_getLogs',[filter(10,10)]),[]);
  assert.equal(rpc.tapeSourceDiagnostics().envio.lastFailure,'envio_duplicate_log');
  assert.equal(rpc.tapeSourceDiagnostics().lastLogSource,'sqd');
});

test('SQD must agree with the pinned hash at the finalized boundary',async()=>{
  const pool=makePool({logs:[{fallback:true}]});
  const {rpc}=adapter({pool,env:{},fetchImpl:async()=>response(sqdLine(20,[],hash(999)))});
  await pin(rpc);
  assert.deepEqual(await rpc(8453,'eth_getLogs',[filter(20,20)]),[{fallback:true}]);
  assert.equal(rpc.tapeSourceDiagnostics().sqd.lastFailure,'sqd_pin_mismatch');
});

test('Envio stays under its free 15 rpm ceiling',async()=>{
  let envioCalls=0,sqdCalls=0;
  const {rpc}=adapter({fetchImpl:async(url)=>{
    if(url===ENVIO_ENDPOINT) {envioCalls++;return response(envioPayload(10,[]));}
    sqdCalls++;return response(sqdRange(10,10));
  }});
  await pin(rpc);
  for(let index=0;index<ENVIO_RATE_LIMIT_PER_MINUTE+1;index++) {
    await rpc(8453,'eth_getLogs',[filter(10,10)]);
  }
  assert.equal(envioCalls,ENVIO_RATE_LIMIT_PER_MINUTE);assert.equal(sqdCalls,1);
  assert.equal(rpc.tapeSourceDiagnostics().envio.lastFailure,'envio_rate_limited');
});

test('declared responses over 2 MiB are abandoned and do not block fallback',async()=>{
  const pool=makePool({logs:[]});
  const {rpc}=adapter({pool,fetchImpl:async(url)=>url===ENVIO_ENDPOINT
    ? response('{}',{headers:{'content-length':String(ADAPTER_MAX_RESPONSE_BYTES+1)}})
    : response('unavailable',{status:503})});
  await pin(rpc);
  assert.deepEqual(await rpc(8453,'eth_getLogs',[filter(10,10)]),[]);
  assert.equal(rpc.tapeSourceDiagnostics().envio.lastFailure,'tape_source_response_too_large');
});

test('pinning, numeric upstream accounting, and range hints remain pool-owned',async()=>{
  const pool=makePool();
  const {rpc}=adapter({pool,env:{},fetchImpl:async()=>response(sqdRange(10,10))});
  await pin(rpc);
  assert.deepEqual(pool.pinned,{chainId:8453,block:PIN});
  assert.equal(rpc.upstreamRequests(),7);assert.equal(typeof rpc.upstreamRequests(),'number');
  assert.equal(rpc.suggestedLogRange(8453,500),75);
  assert.throws(()=>rpc.pinBlock(8453,{number:'0x15',hash:hash(21)}),/tape_adapter_pin_changed/);
});

test('unpinned, out-of-range, and foreign-manager queries fail closed',async()=>{
  const {rpc}=adapter({fetchImpl:async()=>response('{}')});
  await assert.rejects(()=>rpc(8453,'eth_getLogs',[filter(10,10)]),/tape_pin_required/);
  await pin(rpc);
  await assert.rejects(()=>rpc(8453,'eth_getLogs',[filter(20,21)]),/tape_to_after_pinned/);
  await assert.rejects(()=>rpc(8453,'eth_getLogs',[{
    ...filter(10,10),address:'0x1111111111111111111111111111111111111111',
  }]),/tape_filter_address_invalid/);
});

test('non-log methods pass directly to the reviewed pool',async()=>{
  const pool=makePool();
  const {rpc}=adapter({pool,fetchImpl:async()=>{throw new Error('should not fetch');}});
  assert.deepEqual(await rpc(8453,'eth_getBlockByNumber',['finalized',false]),PIN);
  assert.equal(pool.calls[0].method,'eth_getBlockByNumber');
});

let failures=0;
for(const [name,fn] of tests) {
  try {await fn();console.log(`✓ ${name}`);} catch(error) {
    failures++;console.error(`✗ ${name}`);console.error(error);
  }
}
if(failures) process.exitCode=1;
else console.log(`\n${tests.length} Base Tape adapter tests passed.`);
