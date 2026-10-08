import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  BASE_CHAIN_ID, BASE_POOL_MANAGER, BASE_POOL_MANAGER_DEPLOYMENT_BLOCK, INITIALIZE_TOPIC,
  SWAP_TOPIC, TAPE_SCAN_ID, decodeInitializeLog, decodeSwapLog, handleTapeApi, liveTapePoolsForHook, runBaseTapeScan,
} from '../projects/tape.js';

class D1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../drizzle/0007_hook_tape.sql',import.meta.url),'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0008_hook_tape_swaps.sql',import.meta.url),'utf8'));
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

class RPC {
  constructor(tip=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+2000){this.tip=tip;this.logs=[];this.swapLogs=[];this.calls=[];this.failLogs=false;this.pin=null;}
  rpc=async(chainId,method,params)=>{
    assert.equal(chainId,BASE_CHAIN_ID);this.calls.push({method,params:structuredClone(params)});
    if(method==='eth_getBlockByNumber') return {number:quantity(this.tip),hash:hash(this.tip+20_000_000),timestamp:quantity(Math.floor(NOW/1000))};
    if(method==='eth_getLogs') {
      if(this.failLogs) throw Object.assign(new Error('logs unavailable'),{code:'rpc_provider_unavailable'});
      const filter=params[0],from=Number(BigInt(filter.fromBlock)),to=Number(BigInt(filter.toBlock));
      const source=filter.topics[0]===SWAP_TOPIC?this.swapLogs:this.logs;
      return source.filter((log)=>Number(BigInt(log.blockNumber))>=from&&Number(BigInt(log.blockNumber))<=to);
    }
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

test('scanner stores recent finalized evidence, bounded history, and explicit coverage',async()=>{
  const env={DB:new D1()},transport=new RPC(),tip=transport.tip,liveBlock=tip-5,historicalBlock=BASE_POOL_MANAGER_DEPLOYMENT_BLOCK+5;
  transport.logs=[initializeLog({blockNumber:historicalBlock,pool:1,hook:address('4')}),initializeLog({blockNumber:liveBlock,pool:2,hook:address('5'),fee:0x800000})];
  transport.swapLogs=[swapLog({blockNumber:liveBlock+1,pool:2,fee:4321})];
  const result=await runBaseTapeScan(env,{rpc:transport.install(),now:NOW});
  assert.equal(result.status,'ok');assert.equal(result.rows,2);assert.equal(result.liveThrough,tip);
  assert.equal(result.historicalThrough,tip-500);assert.equal(result.historicalComplete,true);
  assert.equal(result.swaps.status,'ok');assert.equal(result.swaps.rows,1);assert.equal(result.swaps.liveThrough,tip);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_tape_pools').first()).n,2);
  const state=await env.DB.prepare('SELECT * FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  assert.equal(state.live_started_block,tip-499);assert.equal(state.live_next_block,tip+1);assert.equal(state.historical_complete,1);
  assert.equal(state.lease_until,0);assert.equal(transport.pin.number,quantity(tip));

  const status=await json(new Request('https://hookline.world/api/tape/status'),env);
  assert.equal(status.response.status,200);assert.equal(status.body.counts.pools,2);assert.equal(status.body.counts.hooks,2);assert.equal(status.body.counts.swaps,1);
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
  await assert.rejects(()=>runBaseTapeScan(env,{rpc,now:NOW+600_000}),/logs unavailable/);
  const after=await env.DB.prepare('SELECT live_next_block,historical_next_block,last_failure,lease_until FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  assert.equal(after.live_next_block,before.live_next_block);assert.equal(after.historical_next_block,before.historical_next_block);
  assert.equal(after.last_failure,'rpc_provider_unavailable');assert.equal(after.lease_until,0);
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
  const post=await handleTapeApi(new Request('https://hookline.world/api/tape/status',{method:'POST'}),env);
  assert.equal(post.status,405);
});

let failures=0;
for(const [name,fn] of tests){
  try{await fn();console.log(`✓ ${name}`);}catch(error){failures++;console.error(`✗ ${name}`);console.error(error);}
}
if(failures) process.exitCode=1;
else console.log(`\n${tests.length} Hook Tape tests passed.`);
