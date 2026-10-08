/**
 * Hook Tape foundation: bounded first-party PoolManager initialization index.
 *
 * The scanner intentionally starts with one chain and one unambiguous event.
 * It never infers swap fees, payouts, or hook behavior from an Initialize log.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
export const BASE_POOL_MANAGER_DEPLOYMENT_BLOCK = 25350988;
export const INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
export const TAPE_SCAN_ID = 'base-poolmanager-initialize-v1';
export const SWAP_TAPE_SCAN_ID = 'base-poolmanager-swap-v1';
export const TAPE_SCHEMA_VERSION = 1;
export const TAPE_DERIVATION_VERSION = 'initialize-v1';
export const SWAP_TAPE_DERIVATION_VERSION = 'swap-event-v1';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const WORD = /^[0-9a-f]{64}$/;
const RANGE_BLOCKS = 500;
const HISTORICAL_WINDOWS_PER_RUN = 8;
const MAX_LOGS_PER_SEGMENT = 100;
const MAX_ROWS_PER_RUN = 500;
const LIVE_LOOKBACK_BLOCKS = RANGE_BLOCKS;
const SWAP_RANGE_BLOCKS = 75;
const SWAP_WINDOWS_PER_RUN = 6;
const SWAP_LIVE_LOOKBACK_BLOCKS = 150;
const MAX_SWAP_LOGS_PER_SEGMENT = 500;
const MAX_SWAP_ROWS_PER_RUN = 1000;
const SWAP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_SWAPS = 200_000;
const MAX_SWAP_PRUNE_PER_RUN = 5_000;
const LEASE_MS = 8 * 60 * 1000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const failure = (code) => Object.assign(new Error(code), { code });
const hex = (number) => `0x${BigInt(number).toString(16)}`;
const iso = (number) => new Date(Number(number)).toISOString();
const safeError = (error) => String(error?.code || error?.message || 'tape_scan_failed').replace(/[^a-z0-9_:-]/gi, '_').slice(0, 120);

function integerQuantity(value, code = 'tape_log_quantity_invalid') {
  const normalized = String(value || '').toLowerCase();
  if (!QUANTITY.test(normalized)) throw failure(code);
  const number = Number(BigInt(normalized));
  if (!Number.isSafeInteger(number) || number < 0) throw failure(code);
  return number;
}

function addressWord(value, code) {
  const normalized = String(value || '').toLowerCase().replace(/^0x/, '');
  if (!WORD.test(normalized) || !/^0{24}/.test(normalized)) throw failure(code);
  return `0x${normalized.slice(24)}`;
}

function signed24(word) {
  const negative=parseInt(word.slice(-6,-5),16)>=8;
  if (negative ? !/^f{58}[89a-f][0-9a-f]{5}$/.test(word) : !/^0{58}[0-7][0-9a-f]{5}$/.test(word)) throw failure('tape_signed24_invalid');
  let value = Number(BigInt(`0x${word}`) & 0xffffffn);
  if (value & 0x800000) value -= 0x1000000;
  return value;
}

function signed128(word) {
  if (!WORD.test(word)) throw failure('tape_signed128_invalid');
  const low=word.slice(32),negative=parseInt(low[0],16)>=8,prefix=word.slice(0,32);
  if ((negative && !/^f{32}$/.test(prefix)) || (!negative && !/^0{32}$/.test(prefix))) throw failure('tape_signed128_invalid');
  let value=BigInt(`0x${low}`);
  if (negative) value-=1n<<128n;
  return value.toString();
}

function jsonHeaders(cache = 'public, max-age=20, s-maxage=60') {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };
}

function response(body, status = 200, cache) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(cache) });
}

function database(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) throw failure('tape_database_unavailable');
  return env.DB;
}

export function decodeInitializeLog(log) {
  if (!log || typeof log !== 'object' || log.removed === true) throw failure('tape_log_invalid');
  const address = String(log.address || '').toLowerCase();
  const transactionHash = String(log.transactionHash || '').toLowerCase();
  const blockHash = String(log.blockHash || '').toLowerCase();
  if (address !== BASE_POOL_MANAGER || !HASH.test(transactionHash) || !HASH.test(blockHash)) throw failure('tape_log_identity_invalid');
  if (!Array.isArray(log.topics) || log.topics.length !== 4 || String(log.topics[0]).toLowerCase() !== INITIALIZE_TOPIC) throw failure('tape_log_topics_invalid');
  const poolId = String(log.topics[1] || '').toLowerCase();
  if (!HASH.test(poolId)) throw failure('tape_pool_id_invalid');
  const currency0 = addressWord(log.topics[2], 'tape_currency_invalid');
  const currency1 = addressWord(log.topics[3], 'tape_currency_invalid');
  const data = String(log.data || '').toLowerCase();
  if (!/^0x[0-9a-f]{320}$/.test(data)) throw failure('tape_log_data_invalid');
  const words = Array.from({ length: 5 }, (_, index) => data.slice(2 + index * 64, 2 + (index + 1) * 64));
  if (!/^0{58}[0-9a-f]{6}$/.test(words[0]) || !/^0{24}[0-9a-f]{40}$/.test(words[3])) throw failure('tape_log_encoding_invalid');
  const feeRaw = Number(BigInt(`0x${words[0]}`) & 0xffffffn);
  const tickSpacing = signed24(words[1]);
  const hookAddress = addressWord(words[2], 'tape_hook_invalid');
  const sqrtPriceX96 = (BigInt(`0x${words[3]}`) & ((1n << 160n) - 1n)).toString();
  const initialTick = signed24(words[4]);
  const blockNumber = integerQuantity(log.blockNumber);
  const logIndex = integerQuantity(log.logIndex);
  return {
    eventId: `${BASE_CHAIN_ID}:${transactionHash}:${logIndex}`,
    chainId: BASE_CHAIN_ID,
    managerAddress: address,
    poolId,
    hookAddress,
    currency0,
    currency1,
    feeRaw,
    feeMode: feeRaw === 0x800000 ? 'dynamic' : 'static',
    tickSpacing,
    sqrtPriceX96,
    initialTick,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    rawLog: {
      address,
      topics: log.topics.map((topic) => String(topic).toLowerCase()),
      data,
      blockNumber: String(log.blockNumber).toLowerCase(),
      blockHash,
      transactionHash,
      logIndex: String(log.logIndex).toLowerCase(),
      removed: false,
    },
  };
}

export function decodeSwapLog(log) {
  if (!log || typeof log !== 'object' || log.removed === true) throw failure('tape_swap_log_invalid');
  const address = String(log.address || '').toLowerCase();
  const transactionHash = String(log.transactionHash || '').toLowerCase();
  const blockHash = String(log.blockHash || '').toLowerCase();
  if (address !== BASE_POOL_MANAGER || !HASH.test(transactionHash) || !HASH.test(blockHash)) throw failure('tape_swap_identity_invalid');
  if (!Array.isArray(log.topics) || log.topics.length !== 3 || String(log.topics[0]).toLowerCase() !== SWAP_TOPIC) throw failure('tape_swap_topics_invalid');
  const poolId=String(log.topics[1] || '').toLowerCase();
  if (!HASH.test(poolId)) throw failure('tape_swap_pool_invalid');
  const sender=addressWord(log.topics[2],'tape_swap_sender_invalid');
  const data=String(log.data || '').toLowerCase();
  if (!/^0x[0-9a-f]{384}$/.test(data)) throw failure('tape_swap_data_invalid');
  const words=Array.from({length:6},(_,index)=>data.slice(2+index*64,2+(index+1)*64));
  if (!/^0{24}[0-9a-f]{40}$/.test(words[2]) || !/^0{32}[0-9a-f]{32}$/.test(words[3]) || !/^0{58}[0-9a-f]{6}$/.test(words[5])) throw failure('tape_swap_encoding_invalid');
  const poolFeeRaw=Number(BigInt(`0x${words[5]}`) & 0xffffffn);
  if (!Number.isSafeInteger(poolFeeRaw) || poolFeeRaw<0 || poolFeeRaw>1_000_000) throw failure('tape_swap_fee_invalid');
  const blockNumber=integerQuantity(log.blockNumber),logIndex=integerQuantity(log.logIndex);
  return {
    eventId:`${BASE_CHAIN_ID}:${transactionHash}:${logIndex}`,
    chainId:BASE_CHAIN_ID,managerAddress:address,poolId,sender,
    amount0:signed128(words[0]),amount1:signed128(words[1]),
    sqrtPriceX96:(BigInt(`0x${words[2]}`)&((1n<<160n)-1n)).toString(),
    liquidity:(BigInt(`0x${words[3]}`)&((1n<<128n)-1n)).toString(),
    tick:signed24(words[4]),poolFeeRaw,blockNumber,blockHash,transactionHash,logIndex,
    rawLog:{address,topics:log.topics.map((topic)=>String(topic).toLowerCase()),data,
      blockNumber:String(log.blockNumber).toLowerCase(),blockHash,transactionHash,
      logIndex:String(log.logIndex).toLowerCase(),removed:false},
  };
}

function poolStatement(db, item, now, finalized) {
  return db.prepare(`INSERT INTO hook_tape_pools(
    event_id,chain_id,manager_address,pool_id,hook_address,currency0,currency1,fee_raw,fee_mode,tick_spacing,
    sqrt_price_x96,initial_tick,block_number,block_hash,transaction_hash,log_index,observed_at,finalized_at_block,finalized_at_hash,raw_log_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(event_id) DO UPDATE SET
    observed_at=MIN(hook_tape_pools.observed_at,excluded.observed_at),
    finalized_at_block=MAX(hook_tape_pools.finalized_at_block,excluded.finalized_at_block),
    finalized_at_hash=CASE WHEN excluded.finalized_at_block>=hook_tape_pools.finalized_at_block THEN excluded.finalized_at_hash ELSE hook_tape_pools.finalized_at_hash END`)
    .bind(item.eventId,item.chainId,item.managerAddress,item.poolId,item.hookAddress,item.currency0,item.currency1,item.feeRaw,item.feeMode,item.tickSpacing,
      item.sqrtPriceX96,item.initialTick,item.blockNumber,item.blockHash,item.transactionHash,item.logIndex,now,finalized.number,finalized.hash,JSON.stringify(item.rawLog));
}

async function savePools(db, items, now, finalized) {
  for (let offset = 0; offset < items.length; offset += 75) {
    await db.batch(items.slice(offset, offset + 75).map((item) => poolStatement(db, item, now, finalized)));
  }
}

function swapStatement(db, item, pool, now, finalized) {
  return db.prepare(`INSERT INTO hook_tape_swaps(
    event_id,chain_id,manager_address,pool_id,hook_address,currency0,currency1,sender,amount0,amount1,
    sqrt_price_x96,liquidity,tick,pool_fee_raw,block_number,block_hash,transaction_hash,log_index,
    observed_at,finalized_at_block,finalized_at_hash,raw_log_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(event_id) DO UPDATE SET
    observed_at=MIN(hook_tape_swaps.observed_at,excluded.observed_at),
    finalized_at_block=MAX(hook_tape_swaps.finalized_at_block,excluded.finalized_at_block),
    finalized_at_hash=CASE WHEN excluded.finalized_at_block>=hook_tape_swaps.finalized_at_block THEN excluded.finalized_at_hash ELSE hook_tape_swaps.finalized_at_hash END`)
    .bind(item.eventId,item.chainId,item.managerAddress,item.poolId,pool.hookAddress,pool.currency0,pool.currency1,item.sender,item.amount0,item.amount1,
      item.sqrtPriceX96,item.liquidity,item.tick,item.poolFeeRaw,item.blockNumber,item.blockHash,item.transactionHash,item.logIndex,
      now,finalized.number,finalized.hash,JSON.stringify(item.rawLog));
}

async function saveSwaps(db, items, pools, now, finalized) {
  for (let offset=0;offset<items.length;offset+=60) {
    await db.batch(items.slice(offset,offset+60).map((item)=>swapStatement(db,item,pools.get(item.poolId),now,finalized)));
  }
}

async function knownHookedPools(db, poolIds) {
  const unique=[...new Set(poolIds)],found=new Map();
  for(let offset=0;offset<unique.length;offset+=75) {
    const ids=unique.slice(offset,offset+75),marks=ids.map(()=>'?').join(',');
    const result=await db.prepare(`SELECT pool_id,hook_address,currency0,currency1 FROM hook_tape_pools
      WHERE chain_id=? AND hook_address!=? AND pool_id IN (${marks})`).bind(BASE_CHAIN_ID,ZERO_ADDRESS,...ids).all();
    for(const row of result?.results || []) found.set(row.pool_id,{hookAddress:row.hook_address,currency0:row.currency0,currency1:row.currency1});
  }
  return found;
}

async function initializeSwapState(db, now) {
  await db.prepare(`INSERT OR IGNORE INTO hook_tape_swap_state(
    id,chain_id,manager_address,last_checked_at,updated_at
  ) VALUES(?,?,?,?,?)`).bind(SWAP_TAPE_SCAN_ID,BASE_CHAIN_ID,BASE_POOL_MANAGER,0,now).run();
}

async function pruneSwaps(db,now) {
  const expired=await db.prepare(`DELETE FROM hook_tape_swaps WHERE event_id IN (
    SELECT event_id FROM hook_tape_swaps WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
  )`).bind(now-SWAP_RETENTION_MS,MAX_SWAP_PRUNE_PER_RUN).run();
  const overflow=await db.prepare(`DELETE FROM hook_tape_swaps WHERE event_id IN (
    SELECT event_id FROM hook_tape_swaps ORDER BY block_number DESC,log_index DESC LIMIT ? OFFSET ?
  )`).bind(MAX_SWAP_PRUNE_PER_RUN,MAX_RETAINED_SWAPS).run();
  return Number(expired?.meta?.changes || 0)+Number(overflow?.meta?.changes || 0);
}

async function initializeState(db, now) {
  await db.prepare(`INSERT OR IGNORE INTO hook_tape_scan_state(
    id,chain_id,manager_address,deployment_block,historical_next_block,last_checked_at,updated_at
  ) VALUES(?,?,?,?,?,?,?)`).bind(TAPE_SCAN_ID,BASE_CHAIN_ID,BASE_POOL_MANAGER,BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,0,now).run();
}

async function acquireLease(db, owner, now) {
  return db.prepare(`UPDATE hook_tape_scan_state SET lease_owner=?,lease_until=?
    WHERE id=? AND (lease_until<? OR lease_owner=?) RETURNING id`)
    .bind(owner,now+LEASE_MS,TAPE_SCAN_ID,now,owner).first();
}

async function releaseLease(db, owner) {
  await db.prepare('UPDATE hook_tape_scan_state SET lease_until=0 WHERE id=? AND lease_owner=?').bind(TAPE_SCAN_ID,owner).run();
}

async function logSegments(rpc, fromBlock, toBlock) {
  const logs = await rpc(BASE_CHAIN_ID, 'eth_getLogs', [{
    address: BASE_POOL_MANAGER,
    topics: [INITIALIZE_TOPIC],
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
  }]);
  if (!Array.isArray(logs)) throw failure('tape_logs_invalid');
  if (logs.length > MAX_LOGS_PER_SEGMENT && fromBlock < toBlock) {
    const middle = Math.floor((fromBlock + toBlock) / 2);
    return [...await logSegments(rpc, fromBlock, middle), ...await logSegments(rpc, middle + 1, toBlock)];
  }
  if (logs.length > MAX_LOGS_PER_SEGMENT) throw failure('tape_log_density_exceeded');
  const decoded = logs.map(decodeInitializeLog).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  const identities = new Set();
  for (const item of decoded) {
    if (item.blockNumber < fromBlock || item.blockNumber > toBlock || identities.has(item.eventId)) throw failure('tape_log_set_invalid');
    identities.add(item.eventId);
  }
  return [{ fromBlock, toBlock, items: decoded }];
}

async function swapLogSegments(rpc, fromBlock, toBlock) {
  const logs=await rpc(BASE_CHAIN_ID,'eth_getLogs',[{
    address:BASE_POOL_MANAGER,topics:[SWAP_TOPIC],fromBlock:hex(fromBlock),toBlock:hex(toBlock),
  }]);
  if(!Array.isArray(logs)) throw failure('tape_swap_logs_invalid');
  if(logs.length>MAX_SWAP_LOGS_PER_SEGMENT && fromBlock<toBlock) {
    const middle=Math.floor((fromBlock+toBlock)/2);
    return [...await swapLogSegments(rpc,fromBlock,middle),...await swapLogSegments(rpc,middle+1,toBlock)];
  }
  if(logs.length>MAX_SWAP_LOGS_PER_SEGMENT) throw failure('tape_swap_density_exceeded');
  const decoded=logs.map(decodeSwapLog).sort((left,right)=>left.blockNumber-right.blockNumber || left.logIndex-right.logIndex);
  const identities=new Set();
  for(const item of decoded) {
    if(item.blockNumber<fromBlock || item.blockNumber>toBlock || identities.has(item.eventId)) throw failure('tape_swap_set_invalid');
    identities.add(item.eventId);
  }
  return [{fromBlock,toBlock,items:decoded}];
}

async function scanSwapWindow({db,rpc,fromBlock,toBlock,now,finalized,rowsRemaining}) {
  if(fromBlock>toBlock || rowsRemaining<=0) return {nextBlock:fromBlock,rows:0,sourceLogs:0,segments:0,stopped:fromBlock<=toBlock};
  const segments=await swapLogSegments(rpc,fromBlock,toBlock);
  let rows=0,sourceLogs=0,nextBlock=fromBlock,savedSegments=0;
  for(const segment of segments) {
    const pools=await knownHookedPools(db,segment.items.map((item)=>item.poolId));
    const matched=segment.items.filter((item)=>pools.has(item.poolId));
    if(rows+matched.length>rowsRemaining) return {nextBlock,rows,sourceLogs,segments:savedSegments,stopped:true};
    await saveSwaps(db,matched,pools,now,finalized);
    const next=segment.toBlock+1;
    await db.prepare(`UPDATE hook_tape_swap_state SET live_next_block=?,finalized_block=?,finalized_hash=?,
      source_logs_seen=source_logs_seen+?,saved_swaps=saved_swaps+?,last_checked_at=?,last_success_at=?,last_failure=NULL,updated_at=? WHERE id=?`)
      .bind(next,finalized.number,finalized.hash,segment.items.length,matched.length,now,now,now,SWAP_TAPE_SCAN_ID).run();
    rows+=matched.length;sourceLogs+=segment.items.length;nextBlock=next;savedSegments++;
  }
  return {nextBlock,rows,sourceLogs,segments:savedSegments,stopped:false};
}

async function scanBaseSwaps(db,rpc,now,finalized) {
  await initializeSwapState(db,now);
  try {
    let state=await db.prepare('SELECT * FROM hook_tape_swap_state WHERE id=?').bind(SWAP_TAPE_SCAN_ID).first();
    const liveStarted=state.live_started_block!=null && Number.isSafeInteger(Number(state.live_started_block))
      ? Number(state.live_started_block) : Math.max(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,finalized.number-SWAP_LIVE_LOOKBACK_BLOCKS+1);
    let liveNext=state.live_next_block!=null && Number.isSafeInteger(Number(state.live_next_block))?Number(state.live_next_block):liveStarted;
    await db.prepare(`UPDATE hook_tape_swap_state SET live_started_block=COALESCE(live_started_block,?),
      live_next_block=COALESCE(live_next_block,?),finalized_block=?,finalized_hash=?,last_checked_at=?,updated_at=? WHERE id=?`)
      .bind(liveStarted,liveNext,finalized.number,finalized.hash,now,now,SWAP_TAPE_SCAN_ID).run();
    let rows=0,sourceLogs=0,segments=0;
    for(let window=0;window<SWAP_WINDOWS_PER_RUN && liveNext<=finalized.number && rows<MAX_SWAP_ROWS_PER_RUN;window++) {
      const result=await scanSwapWindow({db,rpc,fromBlock:liveNext,toBlock:Math.min(finalized.number,liveNext+SWAP_RANGE_BLOCKS-1),
        now,finalized,rowsRemaining:MAX_SWAP_ROWS_PER_RUN-rows});
      if(result.nextBlock===liveNext) break;
      liveNext=result.nextBlock;rows+=result.rows;sourceLogs+=result.sourceLogs;segments+=result.segments;
      if(result.stopped) break;
    }
    await db.prepare(`UPDATE hook_tape_swap_state SET finalized_block=?,finalized_hash=?,last_checked_at=?,last_success_at=?,last_failure=NULL,updated_at=? WHERE id=?`)
      .bind(finalized.number,finalized.hash,now,now,now,SWAP_TAPE_SCAN_ID).run();
    const pruned=await pruneSwaps(db,now);
    state=await db.prepare('SELECT live_started_block,live_next_block FROM hook_tape_swap_state WHERE id=?').bind(SWAP_TAPE_SCAN_ID).first();
    return {status:'ok',rows,sourceLogs,segments,liveFrom:Number(state.live_started_block),liveThrough:Number(state.live_next_block)-1,
      finalizedBlock:finalized.number,lagBlocks:Math.max(0,finalized.number-Number(state.live_next_block)+1),pruned};
  } catch(error) {
    await db.prepare('UPDATE hook_tape_swap_state SET last_checked_at=?,last_failure=?,updated_at=? WHERE id=?')
      .bind(now,safeError(error),now,SWAP_TAPE_SCAN_ID).run();
    return {status:'degraded',rows:0,sourceLogs:0,segments:0,failure:safeError(error)};
  }
}

async function saveSegment(db, stateField, segment, now, finalized, completed = false) {
  await savePools(db, segment.items, now, finalized);
  const completeSql = stateField === 'historical_next_block' ? ',historical_complete=?' : '';
  const values = [segment.toBlock + 1, finalized.number, finalized.hash, now, now, now];
  if (completeSql) values.push(completed ? 1 : 0);
  values.push(TAPE_SCAN_ID);
  await db.prepare(`UPDATE hook_tape_scan_state SET ${stateField}=?,finalized_block=?,finalized_hash=?,last_checked_at=?,last_success_at=?,updated_at=?,last_failure=NULL${completeSql} WHERE id=?`)
    .bind(...values).run();
}

async function scanWindow({ db, rpc, stateField, fromBlock, toBlock, now, finalized, rowsRemaining, historicalBoundary }) {
  if (fromBlock > toBlock || rowsRemaining <= 0) return { nextBlock: fromBlock, rows: 0, segments: 0, stopped: fromBlock <= toBlock };
  const segments = await logSegments(rpc, fromBlock, toBlock);
  let rows = 0, nextBlock = fromBlock, savedSegments = 0;
  for (const segment of segments) {
    if (rows + segment.items.length > rowsRemaining) return { nextBlock, rows, segments: savedSegments, stopped: true };
    const next = segment.toBlock + 1;
    const complete = stateField === 'historical_next_block' && next >= historicalBoundary;
    await saveSegment(db, stateField, segment, now, finalized, complete);
    rows += segment.items.length;
    nextBlock = next;
    savedSegments++;
  }
  return { nextBlock, rows, segments: savedSegments, stopped: false };
}

export async function runBaseTapeScan(env, { rpc, now = Date.now() } = {}) {
  if (typeof rpc !== 'function') throw failure('tape_rpc_required');
  const db = database(env);
  const owner = globalThis.crypto?.randomUUID?.() || `tape-${now}-${Math.random().toString(36).slice(2)}`;
  await initializeState(db, now);
  if (!await acquireLease(db, owner, now)) return { status: 'skipped', reason: 'scan_in_progress' };
  let rows = 0, segments = 0;
  try {
    const block = await rpc(BASE_CHAIN_ID, 'eth_getBlockByNumber', ['finalized', false]);
    const finalized = {
      number: integerQuantity(block?.number, 'tape_finalized_block_invalid'),
      hash: String(block?.hash || '').toLowerCase(),
    };
    if (!HASH.test(finalized.hash) || finalized.number < BASE_POOL_MANAGER_DEPLOYMENT_BLOCK) throw failure('tape_finalized_block_invalid');
    if (typeof rpc.pinBlock !== 'function') throw failure('tape_rpc_pin_required');
    rpc.pinBlock(BASE_CHAIN_ID, block);
    let state = await db.prepare('SELECT * FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
    const liveStarted = state.live_started_block != null && Number.isSafeInteger(Number(state.live_started_block))
      ? Number(state.live_started_block)
      : Math.max(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK, finalized.number - LIVE_LOOKBACK_BLOCKS + 1);
    let liveNext = state.live_next_block != null && Number.isSafeInteger(Number(state.live_next_block)) ? Number(state.live_next_block) : liveStarted;
    let historicalNext = Math.max(BASE_POOL_MANAGER_DEPLOYMENT_BLOCK, Number(state.historical_next_block) || BASE_POOL_MANAGER_DEPLOYMENT_BLOCK);
    await db.prepare(`UPDATE hook_tape_scan_state SET live_started_block=COALESCE(live_started_block,?),live_next_block=COALESCE(live_next_block,?),
      finalized_block=?,finalized_hash=?,last_checked_at=?,updated_at=? WHERE id=?`)
      .bind(liveStarted,liveNext,finalized.number,finalized.hash,now,now,TAPE_SCAN_ID).run();

    if (liveNext <= finalized.number) {
      const result = await scanWindow({ db, rpc, stateField:'live_next_block', fromBlock:liveNext,
        toBlock:Math.min(finalized.number,liveNext+RANGE_BLOCKS-1), now, finalized,
        rowsRemaining:MAX_ROWS_PER_RUN-rows, historicalBoundary:liveStarted });
      liveNext=result.nextBlock;rows+=result.rows;segments+=result.segments;
    }

    // Current swap evidence is more time-sensitive than the bounded historical
    // initialization catch-up. Seed it before archive-provider work begins.
    const swaps=await scanBaseSwaps(db,rpc,now,finalized);
    let historicalFailure=null;
    try {
      for (let window = 0; window < HISTORICAL_WINDOWS_PER_RUN && historicalNext < liveStarted && rows < MAX_ROWS_PER_RUN; window++) {
        const result = await scanWindow({ db, rpc, stateField:'historical_next_block', fromBlock:historicalNext,
          toBlock:Math.min(liveStarted-1,historicalNext+RANGE_BLOCKS-1), now, finalized,
          rowsRemaining:MAX_ROWS_PER_RUN-rows, historicalBoundary:liveStarted });
        if (result.nextBlock === historicalNext) break;
        historicalNext=result.nextBlock;rows+=result.rows;segments+=result.segments;
        if (result.stopped) break;
      }
    } catch(error) {
      historicalFailure=safeError(error);
    }

    await db.prepare(`UPDATE hook_tape_scan_state SET finalized_block=?,finalized_hash=?,last_checked_at=?,last_success_at=?,last_failure=?,
      historical_complete=CASE WHEN historical_next_block>=live_started_block THEN 1 ELSE historical_complete END,updated_at=? WHERE id=?`)
      .bind(finalized.number,finalized.hash,now,now,historicalFailure,now,TAPE_SCAN_ID).run();
    state = await db.prepare('SELECT historical_next_block,live_started_block,live_next_block,historical_complete FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
    return { status:historicalFailure?'degraded':'ok', chainId:BASE_CHAIN_ID, finalizedBlock:finalized.number, rows, segments,
      historicalThrough:Number(state.historical_next_block)-1, liveThrough:Number(state.live_next_block)-1,
      historicalComplete:Boolean(state.historical_complete),historicalFailure,swaps,
      rpcRequests:typeof rpc.upstreamRequests==='function'?rpc.upstreamRequests():null };
  } catch (error) {
    await db.prepare('UPDATE hook_tape_scan_state SET last_checked_at=?,last_failure=?,updated_at=? WHERE id=?')
      .bind(now,safeError(error),now,TAPE_SCAN_ID).run();
    throw error;
  } finally {
    await releaseLease(db, owner);
  }
}

function publicPool(row) {
  let rawLog = null;
  try { rawLog = JSON.parse(row.raw_log_json); } catch { rawLog = null; }
  return {
    id: row.event_id,
    chainId: Number(row.chain_id),
    managerAddress: row.manager_address,
    poolId: row.pool_id,
    hookAddress: row.hook_address,
    currencies: [row.currency0,row.currency1],
    poolFee: { mode: row.fee_mode, raw: Number(row.fee_raw),
      percent: row.fee_mode === 'static' ? Number(row.fee_raw) / 10000 : null },
    tickSpacing: Number(row.tick_spacing),
    sqrtPriceX96: row.sqrt_price_x96,
    initialTick: Number(row.initial_tick),
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    logIndex: Number(row.log_index),
    observedAt: iso(row.observed_at),
    evidence: { kind:'PoolManager Initialize log', finality:'requested at a finalized block',
      finalizedAtBlock:Number(row.finalized_at_block), finalizedAtHash:row.finalized_at_hash,
      derivationVersion:TAPE_DERIVATION_VERSION, rawLog },
  };
}

function publicSwap(row) {
  let rawLog=null;
  try {rawLog=JSON.parse(row.raw_log_json);} catch {rawLog=null;}
  return {
    id:row.event_id,chainId:Number(row.chain_id),managerAddress:row.manager_address,
    poolId:row.pool_id,hookAddress:row.hook_address,currencies:[row.currency0,row.currency1],sender:row.sender,
    poolDeltas:{amount0:row.amount0,amount1:row.amount1,unit:'raw token base units'},
    sqrtPriceX96:row.sqrt_price_x96,liquidity:row.liquidity,tick:Number(row.tick),
    poolManagerFee:{raw:Number(row.pool_fee_raw),percent:Number(row.pool_fee_raw)/10000,
      scope:'fee reported by PoolManager for this swap; excludes separately attributable hook transfers'},
    blockNumber:Number(row.block_number),blockHash:row.block_hash,transactionHash:row.transaction_hash,
    logIndex:Number(row.log_index),observedAt:iso(row.observed_at),
    evidence:{kind:'PoolManager Swap log',finality:'requested at a finalized block',
      finalizedAtBlock:Number(row.finalized_at_block),finalizedAtHash:row.finalized_at_hash,
      derivationVersion:SWAP_TAPE_DERIVATION_VERSION,rawLog},
  };
}

async function tapeStatus(env) {
  const db = database(env);
  const [state, counts, swapState, swapCounts] = await Promise.all([
    db.prepare('SELECT * FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first(),
    db.prepare(`SELECT COUNT(*) AS pools,COUNT(DISTINCT CASE WHEN hook_address!=? THEN hook_address END) AS hooks,
      SUM(CASE WHEN hook_address!=? THEN 1 ELSE 0 END) AS hooked_pools,
      SUM(CASE WHEN fee_mode='dynamic' THEN 1 ELSE 0 END) AS dynamic_pools,
      MIN(block_number) AS first_block,MAX(block_number) AS last_block FROM hook_tape_pools WHERE chain_id=?`).bind(ZERO_ADDRESS,ZERO_ADDRESS,BASE_CHAIN_ID).first(),
    db.prepare('SELECT * FROM hook_tape_swap_state WHERE id=?').bind(SWAP_TAPE_SCAN_ID).first(),
    db.prepare(`SELECT COUNT(*) AS swaps,COUNT(DISTINCT pool_id) AS pools,COUNT(DISTINCT hook_address) AS hooks,
      MIN(block_number) AS first_block,MAX(block_number) AS last_block FROM hook_tape_swaps WHERE chain_id=?`).bind(BASE_CHAIN_ID).first(),
  ]);
  if (!state) throw failure('tape_not_initialized');
  const historicalNext=Number(state.historical_next_block),liveStarted=state.live_started_block==null?null:Number(state.live_started_block),liveNext=state.live_next_block==null?null:Number(state.live_next_block);
  return {
    schemaVersion:TAPE_SCHEMA_VERSION,
    generatedAt:new Date().toISOString(),
    scope:'Finalized Uniswap v4 PoolManager Initialize and Swap logs on Base. Swap rows report pool deltas and the PoolManager fee; separate hook-fee attribution is not included.',
    source:{chainId:BASE_CHAIN_ID,chainName:'Base',managerAddress:BASE_POOL_MANAGER,event:'Initialize',events:['Initialize','Swap'],deploymentBlock:BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,
      contractSource:'https://github.com/Uniswap/contracts/blob/main/deployments/8453.md',interfaceSource:'https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol'},
    counts:{pools:Number(counts?.pools || 0),hookedPools:Number(counts?.hooked_pools || 0),hooks:Number(counts?.hooks || 0),dynamicPools:Number(counts?.dynamic_pools || 0),
      swaps:Number(swapCounts?.swaps || 0),swapPools:Number(swapCounts?.pools || 0),swapHooks:Number(swapCounts?.hooks || 0)},
    coverage:{historicalFrom:BASE_POOL_MANAGER_DEPLOYMENT_BLOCK,historicalThrough:Number.isSafeInteger(historicalNext)?historicalNext-1:null,
      historicalComplete:Boolean(state.historical_complete),liveFrom:Number.isSafeInteger(liveStarted)?liveStarted:null,
      liveThrough:Number.isSafeInteger(liveNext)?liveNext-1:null,finalizedBlock:state.finalized_block==null?null:Number(state.finalized_block),
      finalizedHash:state.finalized_hash || null,gapBlocks:Number.isSafeInteger(liveStarted)&&Number.isSafeInteger(historicalNext)?Math.max(0,liveStarted-historicalNext):null,
      firstSavedBlock:counts?.first_block==null?null:Number(counts.first_block),lastSavedBlock:counts?.last_block==null?null:Number(counts.last_block)},
    scan:{lastCheckedAt:state.last_checked_at?iso(state.last_checked_at):null,lastSuccessAt:state.last_success_at?iso(state.last_success_at):null,
      status:state.last_failure?'degraded':state.last_success_at?'healthy':'initializing',failure:state.last_failure || null},
    swapCoverage:{liveFrom:swapState?.live_started_block==null?null:Number(swapState.live_started_block),
      liveThrough:swapState?.live_next_block==null?null:Number(swapState.live_next_block)-1,
      finalizedBlock:swapState?.finalized_block==null?null:Number(swapState.finalized_block),
      finalizedHash:swapState?.finalized_hash || null,
      lagBlocks:swapState?.live_next_block==null || swapState?.finalized_block==null?null:Math.max(0,Number(swapState.finalized_block)-Number(swapState.live_next_block)+1),
      firstSavedBlock:swapCounts?.first_block==null?null:Number(swapCounts.first_block),lastSavedBlock:swapCounts?.last_block==null?null:Number(swapCounts.last_block),
      sourceLogsSeen:Number(swapState?.source_logs_seen || 0)},
    swapScan:{lastCheckedAt:swapState?.last_checked_at?iso(swapState.last_checked_at):null,
      lastSuccessAt:swapState?.last_success_at?iso(swapState.last_success_at):null,
      status:swapState?.last_failure?'degraded':swapState?.last_success_at?'healthy':'initializing',failure:swapState?.last_failure || null},
    swapRetention:{maxAgeDays:7,maxRows:MAX_RETAINED_SWAPS,pruneLimitPerRun:MAX_SWAP_PRUNE_PER_RUN},
    derivationVersion:TAPE_DERIVATION_VERSION,swapDerivationVersion:SWAP_TAPE_DERIVATION_VERSION,
  };
}

async function tapePools(request, env) {
  const db=database(env),url=new URL(request.url);
  const hook=String(url.searchParams.get('hook') || '').toLowerCase();
  if (hook && !ADDRESS.test(hook)) return response({error:'invalid_hook_address'},400,'no-store');
  const rawLimit=Number(url.searchParams.get('limit') || 50);
  if (!Number.isInteger(rawLimit) || rawLimit<1 || rawLimit>100) return response({error:'invalid_limit'},400,'no-store');
  const cursor=String(url.searchParams.get('cursor') || '');
  let cursorBlock=null,cursorLog=null;
  if (cursor) {
    const match=cursor.match(/^(\d{1,12}):(\d{1,10})$/);
    if (!match) return response({error:'invalid_cursor'},400,'no-store');
    cursorBlock=Number(match[1]);cursorLog=Number(match[2]);
    if (!Number.isSafeInteger(cursorBlock) || !Number.isSafeInteger(cursorLog)) return response({error:'invalid_cursor'},400,'no-store');
  }
  const where=['chain_id=?'],values=[BASE_CHAIN_ID];
  if(hook){where.push('hook_address=?');values.push(hook);}
  if(cursorBlock!=null){where.push('(block_number<? OR (block_number=? AND log_index<?))');values.push(cursorBlock,cursorBlock,cursorLog);}
  values.push(rawLimit+1);
  const result=await db.prepare(`SELECT * FROM hook_tape_pools WHERE ${where.join(' AND ')} ORDER BY block_number DESC,log_index DESC LIMIT ?`).bind(...values).all();
  const rows=Array.isArray(result?.results)?result.results:[];
  const more=rows.length>rawLimit,shown=rows.slice(0,rawLimit),last=shown.at(-1);
  return {schemaVersion:TAPE_SCHEMA_VERSION,generatedAt:new Date().toISOString(),scope:'PoolManager Initialize logs only',
    pools:shown.map(publicPool),nextCursor:more&&last?`${last.block_number}:${last.log_index}`:null};
}

async function tapeSwaps(request,env) {
  const db=database(env),url=new URL(request.url);
  const hook=String(url.searchParams.get('hook') || '').toLowerCase();
  const pool=String(url.searchParams.get('pool') || '').toLowerCase();
  if(hook && !ADDRESS.test(hook)) return response({error:'invalid_hook_address'},400,'no-store');
  if(pool && !HASH.test(pool)) return response({error:'invalid_pool_id'},400,'no-store');
  const rawLimit=Number(url.searchParams.get('limit') || 50);
  if(!Number.isInteger(rawLimit) || rawLimit<1 || rawLimit>100) return response({error:'invalid_limit'},400,'no-store');
  const cursor=String(url.searchParams.get('cursor') || '');let cursorBlock=null,cursorLog=null;
  if(cursor) {
    const match=cursor.match(/^(\d{1,12}):(\d{1,10})$/);
    if(!match) return response({error:'invalid_cursor'},400,'no-store');
    cursorBlock=Number(match[1]);cursorLog=Number(match[2]);
    if(!Number.isSafeInteger(cursorBlock) || !Number.isSafeInteger(cursorLog)) return response({error:'invalid_cursor'},400,'no-store');
  }
  const where=['chain_id=?'],values=[BASE_CHAIN_ID];
  if(hook){where.push('hook_address=?');values.push(hook);}
  if(pool){where.push('pool_id=?');values.push(pool);}
  if(cursorBlock!=null){where.push('(block_number<? OR (block_number=? AND log_index<?))');values.push(cursorBlock,cursorBlock,cursorLog);}
  values.push(rawLimit+1);
  const result=await db.prepare(`SELECT * FROM hook_tape_swaps WHERE ${where.join(' AND ')} ORDER BY block_number DESC,log_index DESC LIMIT ?`).bind(...values).all();
  const rows=Array.isArray(result?.results)?result.results:[],more=rows.length>rawLimit,shown=rows.slice(0,rawLimit),last=shown.at(-1);
  return {schemaVersion:TAPE_SCHEMA_VERSION,generatedAt:new Date().toISOString(),scope:'Finalized PoolManager Swap logs for already-resolved hooked pools',
    swaps:shown.map(publicSwap),nextCursor:more&&last?`${last.block_number}:${last.log_index}`:null};
}

function publicActivitySummary(row) {
  return {swaps:Number(row?.swaps || 0),pools:Number(row?.pools || 0),hooks:Number(row?.hooks || 0),
    senders:Number(row?.senders || 0),firstBlock:row?.first_block==null?null:Number(row.first_block),
    lastBlock:row?.last_block==null?null:Number(row.last_block),
    poolManagerFee:{minRaw:row?.min_fee==null?null:Number(row.min_fee),maxRaw:row?.max_fee==null?null:Number(row.max_fee),
      minPercent:row?.min_fee==null?null:Number(row.min_fee)/10000,maxPercent:row?.max_fee==null?null:Number(row.max_fee)/10000}};
}

async function tapeActivity(request,env) {
  const db=database(env),url=new URL(request.url),hook=String(url.searchParams.get('hook') || '').toLowerCase();
  if(hook && !ADDRESS.test(hook)) return response({error:'invalid_hook_address'},400,'no-store');
  const blocks=Number(url.searchParams.get('blocks') || 1800);
  if(!Number.isInteger(blocks) || blocks<100 || blocks>43_200) return response({error:'invalid_block_window'},400,'no-store');
  const state=await db.prepare('SELECT * FROM hook_tape_swap_state WHERE id=?').bind(SWAP_TAPE_SCAN_ID).first();
  if(!state?.last_success_at || state.live_started_block==null || state.live_next_block==null) {
    return {schemaVersion:TAPE_SCHEMA_VERSION,generatedAt:new Date().toISOString(),window:null,summary:publicActivitySummary(null),hooks:[],pools:[]};
  }
  const liveFrom=Number(state.live_started_block),liveThrough=Number(state.live_next_block)-1,finalizedBlock=Number(state.finalized_block);
  const rawTo=String(url.searchParams.get('toBlock') || '');
  if(rawTo && !/^\d{1,12}$/.test(rawTo)) return response({error:'invalid_to_block'},400,'no-store');
  const toBlock=rawTo?Number(rawTo):liveThrough;
  if(!Number.isSafeInteger(toBlock) || toBlock<liveFrom || toBlock>liveThrough) return response({error:'to_block_outside_saved_coverage'},400,'no-store');
  const requestedFrom=toBlock-blocks+1,fromBlock=Math.max(liveFrom,requestedFrom);
  const where=['chain_id=?','block_number>=?','block_number<=?'],values=[BASE_CHAIN_ID,fromBlock,toBlock];
  if(hook){where.push('hook_address=?');values.push(hook);}
  const clause=where.join(' AND ');
  const summaryRow=await db.prepare(`SELECT COUNT(*) AS swaps,COUNT(DISTINCT pool_id) AS pools,COUNT(DISTINCT hook_address) AS hooks,
    COUNT(DISTINCT sender) AS senders,MIN(pool_fee_raw) AS min_fee,MAX(pool_fee_raw) AS max_fee,
    MIN(block_number) AS first_block,MAX(block_number) AS last_block FROM hook_tape_swaps WHERE ${clause}`).bind(...values).first();
  let hooks=[],pools=[];
  if(hook) {
    const result=await db.prepare(`WITH scoped AS (
      SELECT * FROM hook_tape_swaps WHERE ${clause}
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY pool_id ORDER BY block_number DESC,log_index DESC) AS rn FROM scoped
    ) SELECT pool_id,MAX(currency0) AS currency0,MAX(currency1) AS currency1,COUNT(*) AS swaps,
      COUNT(DISTINCT sender) AS senders,MIN(pool_fee_raw) AS min_fee,MAX(pool_fee_raw) AS max_fee,
      MIN(block_number) AS first_block,MAX(block_number) AS last_block,
      MAX(CASE WHEN rn=1 THEN pool_fee_raw END) AS latest_fee,
      MAX(CASE WHEN rn=1 THEN transaction_hash END) AS latest_transaction
      FROM ranked GROUP BY pool_id ORDER BY swaps DESC,last_block DESC LIMIT 50`).bind(...values).all();
    pools=(result?.results || []).map((row)=>({poolId:row.pool_id,currencies:[row.currency0,row.currency1],...publicActivitySummary({...row,pools:1,hooks:1}),
      latestPoolManagerFee:{raw:Number(row.latest_fee),percent:Number(row.latest_fee)/10000},latestTransactionHash:row.latest_transaction}));
  } else {
    const result=await db.prepare(`SELECT hook_address,COUNT(*) AS swaps,COUNT(DISTINCT pool_id) AS pools,
      COUNT(DISTINCT sender) AS senders,MIN(pool_fee_raw) AS min_fee,MAX(pool_fee_raw) AS max_fee,
      MIN(block_number) AS first_block,MAX(block_number) AS last_block
      FROM hook_tape_swaps WHERE ${clause} GROUP BY hook_address ORDER BY swaps DESC,last_block DESC LIMIT 50`).bind(...values).all();
    hooks=(result?.results || []).map((row)=>({hookAddress:row.hook_address,...publicActivitySummary({...row,hooks:1})}));
  }
  return {schemaVersion:TAPE_SCHEMA_VERSION,generatedAt:new Date().toISOString(),
    scope:'Finalized PoolManager Swap events for already-resolved hooked pools',
    window:{requestedBlocks:blocks,fromBlock,toBlock,coverageStart:liveFrom,complete:requestedFrom>=liveFrom && liveThrough>=finalizedBlock,
      liveThrough,finalizedBlock,lagBlocks:Math.max(0,finalizedBlock-liveThrough)},
    summary:publicActivitySummary(summaryRow),hooks,pools};
}

export async function handleTapeApi(request, env) {
  const url=new URL(request.url),method=request.method.toUpperCase();
  if (!['/api/tape/status','/api/tape/pools','/api/tape/swaps','/api/tape/activity'].includes(url.pathname)) return null;
  if(method!=='GET') return response({error:'method_not_allowed'},405,'no-store');
  try {
    if(url.pathname==='/api/tape/status') return response(await tapeStatus(env));
    if(url.pathname==='/api/tape/swaps') {
      const swaps=await tapeSwaps(request,env);
      return swaps instanceof Response?swaps:response(swaps);
    }
    if(url.pathname==='/api/tape/activity') {
      const activity=await tapeActivity(request,env);
      return activity instanceof Response?activity:response(activity);
    }
    const pools=await tapePools(request,env);
    return pools instanceof Response?pools:response(pools);
  } catch(error) {
    const code=error?.code==='tape_not_initialized'?'tape_initializing':'tape_unavailable';
    const status=error?.code==='tape_not_initialized'?503:503;
    return response({error:code},status,'no-store');
  }
}

/** Bounded live-window relationships for Telegram alerts. Historical catch-up
 * is excluded so an old pool can never be announced as a new pool.
 */
export async function liveTapePoolsForHook(env, chainId, hookAddress, { limit = 200 } = {}) {
  const normalized=String(hookAddress || '').toLowerCase();
  if(Number(chainId)!==BASE_CHAIN_ID || !ADDRESS.test(normalized)) return {available:false,complete:false,pools:[]};
  const db=database(env),cap=Math.min(200,Math.max(1,Math.trunc(Number(limit)||0)));
  const state=await db.prepare('SELECT live_started_block,live_next_block,last_success_at FROM hook_tape_scan_state WHERE id=?').bind(TAPE_SCAN_ID).first();
  if(state?.live_started_block==null || state?.live_next_block==null || !state.last_success_at) return {available:false,complete:false,pools:[]};
  const result=await db.prepare(`SELECT pool_id,transaction_hash,block_number,log_index FROM hook_tape_pools
    WHERE chain_id=? AND hook_address=? AND block_number>=? AND block_number<?
    ORDER BY block_number DESC,log_index DESC LIMIT ?`)
    .bind(BASE_CHAIN_ID,normalized,Number(state.live_started_block),Number(state.live_next_block),cap+1).all();
  const rows=Array.isArray(result?.results)?result.results:[],complete=rows.length<=cap;
  return {available:true,complete,liveFrom:Number(state.live_started_block),liveThrough:Number(state.live_next_block)-1,
    pools:rows.slice(0,cap).map((row)=>({poolId:row.pool_id,transactionHash:row.transaction_hash,blockNumber:Number(row.block_number),logIndex:Number(row.log_index)}))};
}

/** Latest PoolManager-reported swap fee per retained pool for a hook. This is
 * deliberately separate from hook-fee attribution and only becomes alertable
 * when the finalized live cursor has no lag.
 */
export async function liveTapeSwapFeesForHook(env,chainId,hookAddress,{limit=200}={}) {
  const normalized=String(hookAddress || '').toLowerCase();
  if(Number(chainId)!==BASE_CHAIN_ID || !ADDRESS.test(normalized)) return {available:false,complete:false,pools:[]};
  const db=database(env),cap=Math.min(200,Math.max(1,Math.trunc(Number(limit)||0)));
  const state=await db.prepare('SELECT live_next_block,finalized_block,last_success_at,last_failure FROM hook_tape_swap_state WHERE id=?').bind(SWAP_TAPE_SCAN_ID).first();
  if(state?.live_next_block==null || state?.finalized_block==null || !state.last_success_at || state.last_failure) return {available:false,complete:false,pools:[]};
  const result=await db.prepare(`WITH ranked AS (
    SELECT pool_id,pool_fee_raw,block_number,transaction_hash,log_index,
      ROW_NUMBER() OVER(PARTITION BY pool_id ORDER BY block_number DESC,log_index DESC) AS rn
    FROM hook_tape_swaps WHERE chain_id=? AND hook_address=?
  ) SELECT pool_id,pool_fee_raw,block_number,transaction_hash,log_index FROM ranked
    WHERE rn=1 ORDER BY block_number DESC,log_index DESC LIMIT ?`).bind(BASE_CHAIN_ID,normalized,cap+1).all();
  const rows=Array.isArray(result?.results)?result.results:[],lagBlocks=Math.max(0,Number(state.finalized_block)-Number(state.live_next_block)+1);
  return {available:true,complete:rows.length<=cap && lagBlocks===0,liveThrough:Number(state.live_next_block)-1,lagBlocks,
    pools:rows.slice(0,cap).map((row)=>({poolId:row.pool_id,feeRaw:Number(row.pool_fee_raw),feePercent:Number(row.pool_fee_raw)/10000,
      blockNumber:Number(row.block_number),transactionHash:row.transaction_hash,logIndex:Number(row.log_index)}))};
}
