import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  BASE_CHAIN_ID, BASE_POOL_MANAGER, BASE_POOL_MANAGER_DEPLOYMENT_BLOCK, INITIALIZE_TOPIC,
  SWAP_TOPIC, TRANSFER_TOPIC, TAPE_SCAN_ID, decodeInitializeLog, decodeSwapLog, decodeSwapReceipt,
  decodeSwapTrace,
  handleTapeApi, liveTapeActivityForHook, liveTapePoolsForHook, liveTapeSwapFeesForHook, runBaseTapeScan,
} from '../projects/tape.js';

class D1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../drizzle/0007_hook_tape.sql',import.meta.url),'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0008_hook_tape_swaps.sql',import.meta.url),'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0009_hook_tape_receipts.sql',import.meta.url),'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0010_hook_tape_traces.sql',import.meta.url),'utf8'));
  }
  prepare(sql) {
    const database=this;let values=[];
    const statement={
      bind(...args){values=args;return statement;},
      async first(){return database.sqlite.prepare(sql).get(...values)||null;},
      async all(){return {results:database.sqlite.prepare(sql).all(...values)};},
      async run(){return statement._run();},
      _run(){const result=database.sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};},
    };
    return statement;
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {const result=statements.map((statement)=>statement._run());this.sqlite.exec('COMMIT');return result;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}

const NOW=Date.parse('2026-10-07T23:30:00Z');
const address=(digit)=>`0x${digit.repeat(40)}`;
const hash=(number)=>`0x${BigInt(number).toString(16).padStart(64,'0')}`;
const quantity=(number)=>`0x${BigInt(number).toString(16)}`;
const word=(number)=>BigInt(number).toString(16).padStart(64,'0');
const signedWord=(number)=>BigInt(number)<0n?((1n<<256n)+BigInt(number)).toString(16).padStart(64,'f'):word(number);
const addressWord=(value)=>value.slice(2).padStart(64,'0');

function initializeLog({blockNumber,logIndex=0,transaction=blockNumber*100+logIndex,pool=blockNumber,hook=address('4'),currency0=address('1'),currency1=address('2'),fee=3000,tickSpacing=60,tick=-120}={}) {
  return {
    address:BASE_POOL_MANAGER,
    topics:[INITIALIZE_TOPIC,hash(pool),`0x${addressWord(currency0)}`,`0x${addressWord(currency1)}`],
    data:`0x${word(fee)}${signedWord(tickSpacing)}${addressWord(hook)}${word(2n**96n)}${signedWord(tick)}`,
    blockNumber:quantity(blockNumber),blockHash:hash(blockNumber+10_000_000),transactionHash:hash(transaction),logIndex:quantity(logIndex),removed:false,
  };
}

function swapLog({blockNumber,logIndex=0,transaction=blockNumber*100+logIndex,pool=blockNumber,sender=address('8'),amount0=-1000n,amount1=995n,fee=3000,tick=-121}={}) {
  return {
    address:BASE_POOL_MANAGER,
    topics:[SWAP_TOPIC,hash(pool),`0x${addressWord(sender)}`],
    data:`0x${signedWord(amount0)}${signedWord(amount1)}${word(2n**96n)}${word(1_000_000)}${signedWord(tick)}${word(fee)}`,
    blockNumber:quantity(blockNumber),blockHash:hash(blockNumber+10_000_000),transactionHash:hash(transaction),logIndex:quantity(logIndex),removed:false,
  };
}

function transferLog({blockNumber,transaction,logIndex=1,token=address('1'),from=address('8'),to=address('4'),value=25n}={}) {
  return {address:token,topics:[TRANSFER_TOPIC,`0x${addressWord(from)}`,`0x${addressWord(to)}`],data:`0x${word(value)}`,
    blockNumber:quantity(blockNumber),blockHash:hash(blockNumber+10_000_000),transactionHash:hash(transaction),logIndex:quantity(logIndex),removed:false};
}

function receipt({blockNumber,transaction,logs=[]}={}) {
  return {transactionHash:hash(transaction),blockNumber:quantity(blockNumber),blockHash:hash(blockNumber+10_000_000),status:'0x1',
    gasUsed:'0x249f0',effectiveGasPrice:'0x4c4b40',logs};
}

const packed128=(number)=>((BigInt(number)<0n?(1n<<128n)+BigInt(number):BigInt(number)).toString(16).padStart(32,'0'));
function traceCall({blockNumber,transaction,traceAddress=[],from=BASE_POOL_MANAGER,to=address('4'),selector='0x575e24b4',
  value=0n,gas=500_000n,gasUsed=50_000n,output,success=true}={}) {
  const selectorWord=`${selector.slice(2)}${'0'.repeat(56)}`;
  const callbackOutput=output || `0x${selectorWord}${packed128(-5n)}${packed128(7n)}${word(0x400bb8)}`;
  return {blockHash:hash(blockNumber+10_000_000),blockNumber,transactionHash:hash(transaction),type:'call',
    action:{from,to,callType:'call',gas:quantity(gas),input:`${selector}${'0'.repeat(64)}`,value:quantity(value)},
    ...(success?{result:{gasUsed:quantity(gasUsed),output:callbackOutput}}:{error:'Reverted'}),traceAddress,subtraces:0};
}

class RPC {
  constructor(tip=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+2000){this.tip=tip;this.logs=[];this.swapLogs=[];this.receipts=new Map();this.traces=new Map();this.calls=[];this.failLogs=false;this.pin=null;}
  rpc=async(chainId,method,params)=>{
    assert.equal(chainId,BASE_CHAIN_ID);this.calls.push({method,params:structuredClone(params)});
    if(method==='eth_getBlockByNumber') return {number:quantity(this.tip),hash:hash(this.tip+20_000_000),timestamp:quantity(Math.floor(NOW/1000))};
    if(method==='eth_getLogs') {
      if(this.failLogs) throw Object.assign(new Error('logs unavailable'),{code:'rpc_provider_unavailable'});
      const filter=params[0],from=Number(BigInt(filter.fromBlock)),to=Number(BigInt(filter.toBlock));
      const source=filter.topics[0]===SWAP_TOPIC?this.swapLogs:this.logs;
      return source.filter((log)=>Number(BigInt(log.blockNumber))>=from&&Number(BigInt(log.blockNumber))<=to);
    }
    if(method==='eth_getTransactionReceipt') return this.receipts.get(params[0]) || null;
    if(method==='trace_transaction') return this.traces.get(params[0]) || [];
    throw new Error(`Unexpected method ${method}`);
  };
  install(){this.rpc.pinBlock=(chainId,block)=>{assert.equal(chainId,BASE_CHAIN_ID);this.pin=block;};this.rpc.upstreamRequests=()=>this.calls.length;return this.rpc;}
}

const tests=[];
function test(name,fn){tests.push([name,fn]);}
async function json(request,env){const response=await handleTapeApi(request,env);return {response,body:await response.json()};}

test('strict Initialize decoding preserves signed fields and dynamic fee identity',()=>{
  const source=initializeLog({blockNumber:BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+1,fee:0x800000,tickSpacing:-12,tick:-887272});
  const decoded=decodeInitializeLog(source);
  assert.equal(decoded.feeMode,'dynamic');
  assert.equal(decoded.feeRaw,0x800000);
  assert.equal(decoded.tickSpacing,-12);
  assert.equal(decoded.initialTick,-887272);
  assert.equal(decoded.sqrtPriceX96,(2n**96n).toString());
  assert.equal(decoded.hookAddress,address('4'));
  assert.equal(decoded.rawLog.data,source.data);
  assert.throws(()=>decodeInitializeLog({...source,address:address('9')}),/tape_log_identity_invalid/);
  assert.throws(()=>decodeInitializeLog({...source,removed:true}),/tape_log_invalid/);
  assert.throws(()=>decodeInitializeLog({...source,data:'0x00'}),/tape_log_data_invalid/);
});

test('strict Swap decoding preserves signed pool deltas and the reported swap fee',()=>{
  const source=swapLog({blockNumber:BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+2,amount0:-(2n**120n),amount1:2n**119n,fee:12_345,tick:-222});
  const decoded=decodeSwapLog(source);
  assert.equal(decoded.amount0,(-(2n**120n)).toString());assert.equal(decoded.amount1,(2n**119n).toString());
  assert.equal(decoded.poolFeeRaw,12_345);assert.equal(decoded.tick,-222);assert.equal(decoded.sender,address('8'));
  assert.throws(()=>decodeSwapLog({...source,data:'0x00'}),/tape_swap_data_invalid/);
  assert.throws(()=>decodeSwapLog({...source,topics:[INITIALIZE_TOPIC,...source.topics.slice(1)]}),/tape_swap_topics_invalid/);
});

test('receipt decoding retains relevant ERC-20 flows without calling them fees',()=>{
  const blockNumber=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+3,transaction=777,hook=address('4');
  const context={transactionHash:hash(transaction),blockNumber,blockHash:hash(blockNumber+10_000_000),hookAddress:hook,currency0:address('1'),currency1:address('0')};
  const relevant=transferLog({blockNumber,transaction,token:address('1'),from:address('8'),to:address('9'),value:25n});
  const hookLinked=transferLog({blockNumber,transaction,logIndex:2,token:address('7'),from:hook,to:address('6'),value:5n});
  const unrelated=transferLog({blockNumber,transaction,logIndex:3,token:address('7'),from:address('8'),to:address('9'),value:7n});
  const decoded=decodeSwapReceipt(receipt({blockNumber,transaction,logs:[relevant,hookLinked,unrelated]}),[context]);
  assert.equal(decoded.transferLogs,3);assert.equal(decoded.currencyTransfers,1);assert.equal(decoded.hookLinkedTransfers,1);
  assert.equal(decoded.selectedTransfers.length,2);assert.equal(decoded.selectedTransfers[0].value,'25');assert.equal(decoded.truncated,false);
  assert.throws(()=>decodeSwapReceipt({...receipt({blockNumber,transaction,logs:[relevant]}),blockHash:hash(9)},[context]),/tape_receipt_source_mismatch/);
  assert.throws(()=>decodeSwapReceipt(receipt({blockNumber,transaction,logs:[{...relevant,data:'0x00'}]}),[context]),/tape_receipt_transfer_invalid/);
});

test('trace decoding identifies callbacks, returned deltas, fee overrides and hook-linked value without calling them fees',()=>{
  const blockNumber=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+4,transaction=778,hook=address('4');
  const context={transactionHash:hash(transaction),blockNumber,blockHash:hash(blockNumber+10_000_000),managerAddress:BASE_POOL_MANAGER,
    hookAddress:hook,currency0:address('1'),currency1:address('2')};
  const callback=traceCall({blockNumber,transaction,to:hook,gasUsed:54_001n});
  const nativeReturn=traceCall({blockNumber,transaction,traceAddress:[0],from:address('1'),to:hook,selector:'0x',value:11n,gasUsed:55n,output:'0x'});
  const decoded=decodeSwapTrace([callback,nativeReturn],[context]);
  assert.equal(decoded.traceItems,2);assert.equal(decoded.hookCalls,2);assert.equal(decoded.hookCallGasUsed,'54056');
  assert.equal(decoded.nativeValueCalls,1);assert.equal(decoded.selectedCalls[0].callback,'beforeSwap');
  assert.equal(decoded.selectedCalls[0].callbackReturn.deltaSpecified,'-5');assert.equal(decoded.selectedCalls[0].callbackReturn.deltaUnspecified,'7');
  assert.equal(decoded.selectedCalls[0].callbackReturn.lpFeeOverrideRaw,3000);
  assert.throws(()=>decodeSwapTrace([{...callback,transactionHash:hash(9)}],[context]),/tape_trace_source_mismatch/);
  assert.throws(()=>decodeSwapTrace([{...callback,action:{...callback.action,input:'0x0'}}],[context]),/tape_trace_data_invalid/);
});

test('scanner stores recent finalized evidence, bounded history, and explicit coverage',async()=>{
  const env={DB:new D1()},transport=new RPC(),tip=transport.tip,liveBlock=tip-5,historicalBlock=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+5;
  transport.logs=[initializeLog({blockNumber:historicalBlock,pool:1,hook:address('4')}),initializeLog({blockNumber:liveBlock,pool:2,hook:address('5'),fee:0x800000})];
  transport.swapLogs=[swapLog({blockNumber:liveBlock+1,pool:2,fee:4321})];
  const swapTransaction=(liveBlock+1)*100;
  transport.receipts.set(hash(swapTransaction),receipt({blockNumber:liveBlock+1,transaction:swapTransaction,
    logs:[transferLog({blockNumber:liveBlock+1,transaction:swapTransaction,token:address('1'),from:address('8'),to:address('5'),value:44n})]}));
  transport.traces.set(hash(swapTransaction),[
    traceCall({blockNumber:liveBlock+1,transaction:swapTransaction,to:address('5'),gasUsed:61_000n}),
    traceCall({blockNumber:liveBlock+1,transaction:swapTransaction,traceAddress:[0],from:address('5'),to:address('1'),selector:'0xa9059cbb',gasUsed:8_000n,output:'0x'}),
  ]);
  const result=await runBaseTapeScan(env,{rpc:transport.install(),now:NOW});
  assert.equal(result.status,'ok');assert.equal(result.rows,2);assert.equal(result.liveThrough,tip);
  assert.equal(result.historicalThrough,tip-500);assert.equal(result.historicalComplete,true);
  assert.equal(result.swaps.status,'ok');assert.equal(result.swaps.rows,1);assert.equal(result.swaps.liveThrough,tip);
  assert.equal(result.receipts.status,'ok');assert.equal(result.receipts.saved,1);
  assert.equal(result.traces.status,'ok');assert.equal(result.traces.saved,1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_pools').first()).n,2);
  const state=await env.DB.prepare('SELECT * FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  assert.equal(state.live_started_block,tip-499);assert.equal(state.live_next_block,tip+1);assert.equal(state.historical_complete,1);
  assert.equal(state.lease_until,0);assert.equal(transport.pin.number,quantity(tip));

  const status=await json(new Request('https://hookline.world/api/tape/status'),env);
  assert.equal(status.response.status,200);assert.equal(status.body.counts.pools,2);assert.equal(status.body.counts.hooks,2);assert.equal(status.body.counts.swaps,1);
  assert.equal(status.body.counts.receipts,1);assert.equal(status.body.counts.retainedRelevantTransfers,1);
  assert.equal(status.body.counts.traces,1);assert.equal(status.body.counts.hookCallFrames,1);
  assert.equal(status.body.coverage.liveThrough,tip);assert.equal(status.body.coverage.gapBlocks,0);
  assert.equal(status.body.swapCoverage.liveThrough,tip);assert.match(status.body.scope,/Initialize and Swap logs/i);
  const pools=await json(new Request(`https://hookline.world/api/tape/pools?hook=${address('5')}&limit=10`),env);
  assert.equal(pools.body.pools.length,1);assert.equal(pools.body.pools[0].hookAddress,address('5'));
  assert.equal(pools.body.pools[0].poolFee.mode,'dynamic');assert.equal(pools.body.pools[0].evidence.derivationVersion,'initialize-v1');
  assert.equal(pools.body.pools[0].evidence.rawLog.transactionHash,hash(liveBlock*100));
  const alertPools=await liveTapePoolsForHook(env,BASE_CHAIN_ID,address('5'));
  assert.equal(alertPools.available,true);assert.equal(alertPools.complete,true);assert.equal(alertPools.pools.length,1);
  assert.equal(alertPools.pools[0].blockNumber,liveBlock);
  assert.equal((await liveTapePoolsForHook(env,BASE_CHAIN_ID,address('4'))).pools.length,0,'Historical backfill must not become a new-pool alert.');
  const swaps=await json(new Request(`https://hookline.world/api/tape/swaps?hook=${address('5')}&limit=10`),env);
  assert.equal(swaps.response.status,200);assert.equal(swaps.body.swaps.length,1);
  assert.equal(swaps.body.swaps[0].poolManagerFee.percent,0.4321);assert.equal(swaps.body.swaps[0].poolDeltas.amount0,'-1000');
  assert.equal(swaps.body.swaps[0].evidence.derivationVersion,'swap-event-v1');
  assert.equal(swaps.body.swaps[0].receipt.tokenFlows.length,1);assert.equal(swaps.body.swaps[0].receipt.tokenFlows[0].value,'44');
  assert.equal(swaps.body.swaps[0].receipt.tokenFlows[0].relationship.touchesHook,true);
  assert.equal(swaps.body.swaps[0].trace.hookCallFrames,1);assert.equal(swaps.body.swaps[0].trace.hookOutboundCallFrames,1);
  assert.equal(swaps.body.swaps[0].trace.calls[0].callback,'beforeSwap');
  assert.equal(swaps.body.swaps[0].trace.calls[0].callbackReturn.lpFeeOverridePercent,0.3);
  const activity=await json(new Request(`https://hookline.world/api/tape/activity?hook=${address('5')}&blocks=500`),env);
  assert.equal(activity.response.status,200);assert.equal(activity.body.summary.swaps,1);assert.equal(activity.body.summary.pools,1);
  assert.equal(activity.body.summary.poolManagerFee.minPercent,0.4321);assert.equal(activity.body.pools[0].latestTransactionHash,hash((liveBlock+1)*100));
  assert.equal(activity.body.window.complete,false,'A requested window older than retained live coverage must stay partial.');
  const latestFees=await liveTapeSwapFeesForHook(env,BASE_CHAIN_ID,address('5'));
  assert.equal(latestFees.available,true);assert.equal(latestFees.complete,true);assert.equal(latestFees.pools[0].feeRaw,4321);
  const seededActivity=await liveTapeActivityForHook(env,BASE_CHAIN_ID,address('5'));
  assert.equal(seededActivity.newSwaps,0);assert.equal(seededActivity.cursor.blockNumber,liveBlock+1);
  const emptySeed=await liveTapeActivityForHook(env,BASE_CHAIN_ID,address('9'));
  assert.equal(emptySeed.newSwaps,0);assert.equal(emptySeed.cursor.blockNumber,tip);
  transport.tip=tip+10;transport.swapLogs.push(swapLog({blockNumber:tip+2,pool:2,fee:5555,transaction:991122}));
  await runBaseTapeScan(env,{rpc:transport.install(),now:NOW+600_000});
  const newActivity=await liveTapeActivityForHook(env,BASE_CHAIN_ID,address('5'),{cursor:seededActivity.cursor});
  assert.equal(newActivity.complete,true);assert.equal(newActivity.newSwaps,1);assert.equal(newActivity.pools,1);
  assert.equal(newActivity.poolManagerFee.minRaw,5555);assert.equal(newActivity.cursor.blockNumber,tip+2);
});

test('reruns are idempotent and historical catch-up meets the live boundary',async()=>{
  const env={DB:new D1()},transport=new RPC(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+600);
  transport.logs=[initializeLog({blockNumber:BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+10,pool:3})];
  const rpc=transport.install();
  const first=await runBaseTapeScan(env,{rpc,now:NOW});
  assert.equal(first.historicalComplete,true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_pools').first()).n,1);
  const second=await runBaseTapeScan(env,{rpc,now:NOW+600_000});
  assert.equal(second.status,'ok');assert.equal(second.rows,0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_pools').first()).n,1);
});

test('scanner retries provider response limits in smaller windows without moving evidence boundaries',async()=>{
  const env={DB:new D1()},transport=new RPC(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+20),tip=transport.tip;
  transport.logs=[initializeLog({blockNumber:tip-2,pool:31,hook:address('3')})];
  transport.swapLogs=[swapLog({blockNumber:tip-1,pool:31,fee:3000})];
  const source=transport.install(),widths=[];
  const rpc=async(chainId,method,params)=>{
    if(method==='eth_getLogs') {
      const width=Number(BigInt(params[0].toBlock)-BigInt(params[0].fromBlock)+1n);widths.push(width);
      if(width>10) throw Object.assign(new Error('rpc_log_range_limited'),{code:'rpc_log_range_limited',suggestedRange:10});
    }
    return source(chainId,method,params);
  };
  rpc.pinBlock=source.pinBlock;rpc.upstreamRequests=source.upstreamRequests;
  const result=await runBaseTapeScan(env,{rpc,now:NOW});
  assert.equal(result.status,'ok');assert.equal(result.swaps.status,'ok');
  assert.ok(widths.some(width=>width>10));assert.ok(widths.some(width=>width<=10));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_pools').first()).n,1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_swaps').first()).n,1);
});

test('bounded swap retention prunes expired raw rows without moving evidence cursors backward',async()=>{
  const env={DB:new D1()},transport=new RPC(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+600),tip=transport.tip,pool=77;
  transport.logs=[initializeLog({blockNumber:tip-10,pool,hook:address('7')})];
  transport.swapLogs=[swapLog({blockNumber:tip-5,pool})];
  const rpc=transport.install();
  await runBaseTapeScan(env,{rpc,now:NOW});
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_swaps').first()).n,1);
  await env.DB.prepare('UPDATE hook_tape_swaps SET observed_at=?').bind(NOW-8*24*60*60*1000).run();
  const before=await env.DB.prepare('SELECT live_next_block FROM hook_tape_swap_state').first();
  const rerun=await runBaseTapeScan(env,{rpc,now:NOW+8*24*60*60*1000});
  const after=await env.DB.prepare('SELECT live_next_block FROM hook_tape_swap_state').first();
  assert.equal(rerun.swaps.pruned,1);assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_swaps').first()).n,0);
  assert.equal(after.live_next_block,before.live_next_block);
  const status=await json(new Request('https://hookline.world/api/tape/status'),env);
  assert.equal(status.body.swapRetention.maxAgeDays,7);assert.equal(status.body.swapRetention.maxRows,200000);
});

test('failed log reads retain cursors and last good evidence',async()=>{
  const env={DB:new D1()},transport=new RPC(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+600),rpc=transport.install();
  await runBaseTapeScan(env,{rpc,now:NOW});
  const before=await env.DB.prepare('SELECT live_next_block,historical_next_block FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  transport.tip+=10;transport.failLogs=true;
  const result=await runBaseTapeScan(env,{rpc,now:NOW+600_000});assert.equal(result.status,'degraded');
  const after=await env.DB.prepare('SELECT live_next_block,historical_next_block,last_failure,lease_until FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  assert.equal(after.live_next_block,before.live_next_block);assert.equal(after.historical_next_block,before.historical_next_block);
  assert.equal(after.last_failure,'rpc_provider_unavailable');assert.equal(after.lease_until,0);
});

test('finalized swaps advance before an unavailable Initialize catch-up window',async()=>{
  const env={DB:new D1()},transport=new RPC(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+600),tip=transport.tip,pool=88;
  transport.logs=[initializeLog({blockNumber:tip-10,pool,hook:address('8')})];
  await runBaseTapeScan(env,{rpc:transport.install(),now:NOW});
  transport.tip=tip+10;transport.swapLogs=[swapLog({blockNumber:tip+2,pool,fee:4500})];
  const source=transport.install();
  const rpc=async(chainId,method,params)=>{
    if(method==='eth_getLogs' && params[0].topics[0]===INITIALIZE_TOPIC) throw Object.assign(new Error('initialize unavailable'),{code:'rpc_provider_unavailable'});
    return source(chainId,method,params);
  };
  rpc.pinBlock=source.pinBlock;rpc.upstreamRequests=source.upstreamRequests;
  const result=await runBaseTapeScan(env,{rpc,now:NOW+600_000});
  assert.equal(result.status,'degraded');assert.equal(result.liveFailure,'rpc_provider_unavailable');
  assert.equal(result.swaps.status,'ok');assert.equal(result.swaps.rows,1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_swaps').first()).n,1);
});

test('active lease skips overlap and public query validation fails closed',async()=>{
  const env={DB:new D1()},transport=new RPC(),rpc=transport.install();
  await env.DB.prepare(`INSERT INTO hook_tape_scan_state(id,chain_id,manager_address,deployment_block,historical_next_block,last_checked_at,updated_at,lease_owner,lease_until)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(TAPE_SCAN_ID,BASE_CHAIN_ID,BASE_POOL_MANAGER,BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,0,NOW,'other',NOW+60_000).run();
  assert.deepEqual(await runBaseTapeScan(env,{rpc,now:NOW}),{status:'skipped',reason:'scan_in_progress'});
  assert.equal(transport.calls.length,0);
  assert.equal((await json(new Request('https://hookline.world/api/tape/pools?hook=bad'),env)).response.status,400);
  assert.equal((await json(new Request('https://hookline.world/api/tape/pools?limit=101'),env)).response.status,400);
  assert.equal((await json(new Request('https://hookline.world/api/tape/pools?cursor=nope'),env)).response.status,400);
  assert.equal((await json(new Request('https://hookline.world/api/tape/swaps?pool=bad'),env)).response.status,400);
  assert.equal((await json(new Request('https://hookline.world/api/tape/activity?blocks=99'),env)).response.status,400);
  const post=await handleTapeApi(new Request('https://hookline.world/api/tape/status',{method:'POST'}),env);
  assert.equal(post.status,405);
});

let failures=0;
for(const [name,fn] of tests){
  try{await fn();console.log(`✓ ${name}`);}catch(error){failures++;console.error(`✗ ${name}`);console.error(error);}
}
if(failures) process.exitCode=1;
else console.log(`\n${tests.length} Hook Tape tests passed.`);
