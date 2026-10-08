/** Bounded, read-only ingestion transport. URLs are operator-reviewed constants,
 * never supplied by a request, project submission, or project metadata.
 * Health is best-effort warm-isolate state, not a promise of global availability.
 */
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const provider = (id,url,sourceUrl) => ({id,url,sourceUrl});
const ethPublic = provider('ethereum-publicnode','https://ethereum-rpc.publicnode.com','https://ethereum.publicnode.com/');
const ethDrpc = provider('ethereum-drpc','https://eth.drpc.org','https://drpc.org/docs/ethereum-api');
const basePublic = provider('base-publicnode','https://base-rpc.publicnode.com','https://base.publicnode.com/');
const baseTenderly = provider('base-tenderly','https://base.gateway.tenderly.co','https://tenderly.co/blog/changelog/tenderly-now-supports-base-mainnet-goerli-testnet/');
const baseOfficial = provider('base-official','https://mainnet.base.org','https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getTransactionCount');
const baseDrpc = provider('base-drpc','https://base.drpc.org','https://drpc.org/chainlist/base');
const arbOfficial = provider('arbitrum-official','https://arb1.arbitrum.io/rpc','https://docs.arbitrum.io/chain-info');
const arbPublic = provider('arbitrum-publicnode','https://arbitrum-one-rpc.publicnode.com','https://arbitrum-one.publicnode.com/');
const bnbOfficial = provider('bnb-official','https://bsc-dataseed.bnbchain.org','https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/');
const bnbPublic = provider('bnb-publicnode','https://bsc-rpc.publicnode.com','https://bsc.publicnode.com/');
const rhOfficial = provider('robinhood-official','https://rpc.mainnet.chain.robinhood.com','https://docs.robinhood.com/chain/connecting/');
const rhDrpc = provider('robinhood-drpc','https://robinhood.drpc.org','https://blog.drpc.org/robinhood-mainnet-and-new-networks-drpc/');

export const PROJECT_RPC_POOLS = freeze({
  1:{headers:[ethPublic,ethDrpc],state:[ethPublic,ethDrpc],logs:[ethPublic,ethDrpc],traces:[]},
  // PublicNode's public Base tier rejects finalized historical state. It does
  // serve the bounded log windows. Do not retry state there as if it were fresh.
  8453:{headers:[basePublic,baseTenderly],state:[baseTenderly,baseOfficial,baseDrpc],logs:[basePublic,baseTenderly],traces:[baseDrpc]},
  42161:{headers:[arbOfficial,arbPublic],state:[arbOfficial,arbPublic],logs:[arbOfficial,arbPublic],traces:[]},
  // BNB explicitly disables eth_getLogs on its official public endpoints.
  56:{headers:[bnbOfficial,bnbPublic],state:[bnbOfficial,bnbPublic],logs:[bnbPublic],traces:[]},
  // No independently usable free historical-log fallback has been verified.
  // PublicNode requires an archive token; dRPC rejects even small historical
  // ranges with a misleading 10,000-block error. Keep that gap explicit.
  4663:{headers:[rhOfficial,rhDrpc],state:[rhDrpc],logs:[rhOfficial],traces:[]},
});

const METHODS = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call','eth_getLogs','eth_getTransactionReceipt','trace_transaction']);
const STATE = new Set(['eth_getCode','eth_getStorageAt','eth_call']);
const HASH = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x[0-9a-f]+$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RANGE = 8000;
const MAX_REQUESTS = 240;
const MAX_SECONDS = 42;
const GROUPS = ['headers','state','logs','traces'];
const groupFor = method => method==='eth_getLogs'?'logs':method==='trace_transaction'?'traces':STATE.has(method) || method==='eth_getTransactionReceipt'?'state':'headers';
const failure = (code,extra={}) => Object.assign(new Error(code),{code,...extra});
const numberOf = value => {
  if (!QUANTITY.test(String(value))) throw failure('rpc_invalid_block');
  const valueNumber = Number(BigInt(value));
  if (!Number.isSafeInteger(valueNumber)) throw failure('rpc_invalid_block');
  return valueNumber;
};
const traceNumberOf = value => Number.isSafeInteger(value) && value>=0 ? value : numberOf(value);

export function createRpcPoolHealth() { return new Map(); }

/** Classify a provider response without treating a quota or access rejection
 * as evidence that a requested block range was too wide.
 */
export function classifyProjectRpcFailure({status=0,message='',rpcCode,method,width,retryAfterMs=0}={}) {
  const text=String(message).slice(0,2000);
  if (status===429 || /rate.?limit|too many requests|request quota|quota exceeded|compute units|requests per second/i.test(text)) {
    return failure('rpc_rate_limited',{retryAfterMs});
  }
  if (rpcCode===3 || /execution reverted|revert opcode/i.test(text)) return failure('rpc_execution_reverted',{terminal:true});
  if (/archive|historical state|missing trie|pruned|personal.*token/i.test(text)) return failure('rpc_archive_unavailable');
  if (status===401 || status===403) return failure('rpc_access_denied');
  if (method==='eth_getBlockByNumber' && /unsupported finality|finalized.*(unsupported|not supported|invalid)|unsupported.*finalized|invalid.*finalized/i.test(text)) {
    return failure('rpc_finality_unsupported');
  }
  if (rpcCode===-32601 || /method (not found|not supported|disabled)/i.test(text)) return failure('rpc_method_unavailable');
  if (method==='eth_getLogs') {
    // In particular, dRPC's "over 10000 blocks" rejection for a 480-block
    // historical query is NOT a legitimate 10,000-block range constraint.
    const stated=text.match(/(?:over|maximum(?: of)?|up to|limited to|limit(?: of| is)?|max(?:imum)?(?: block range)?[=:]?)\s*([\d,]+)\s*blocks?/i)
      || text.match(/block range[^\d]{0,35}([\d,]+)(?:\s|$)/i);
    if (stated && /range|blocks?/i.test(text)) {
      const max=Number(stated[1].replace(/,/g,''));
      if (Number.isSafeInteger(max) && max>0 && width>max) return failure('rpc_log_range_limited',{suggestedRange:max});
      return failure('rpc_log_capability_unavailable');
    }
    if (/query returned more than|too many (results|logs)|response (size|too large)|log (response|result).*(large|limit)|block range (is )?too (large|wide)/i.test(text)) {
      return failure('rpc_log_range_limited',{suggestedRange:Math.max(1,Math.floor(width/2))});
    }
  }
  if (status>=500 || /timeout|timed out|temporar|network|connection|fetch failed|unavailable/i.test(text)) return failure('rpc_provider_unavailable');
  if (status===400 || rpcCode===-32602) return failure('rpc_request_rejected');
  return failure('rpc_provider_unavailable');
}

function retryDelay(header,now) {
  if (!header) return 0;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Math.max(0,Number(header)*1000);
  const date=Date.parse(header);return Number.isFinite(date)?Math.max(0,date-now):0;
}

export function createProjectRpcPool({health=createRpcPoolHealth(),fetchImpl=fetch,now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxRequests=MAX_REQUESTS,deadlineAt=now()+MAX_SECONDS*1000}={}) {
  if (!(health instanceof Map)) throw failure('rpc_health_invalid');
  const hardLimit=Math.min(MAX_REQUESTS,Math.max(0,Math.trunc(Number(maxRequests)||0)));
  const deadline=Math.min(Number(deadlineAt),now()+MAX_SECONDS*1000);
  if (!Number.isFinite(deadline)) throw failure('scan_deadline');
  let requests=0,sequence=0;
  const chainVerified=new Set(),pins=new Map(),verifiedPins=new Map(),seenHeaders=new Map(),nextSend=new Map();
  const failures=[];
  const getHealth=(id,group)=>{
    const key=`${id}:${group}`;
    if (!health.has(key)) health.set(key,{failures:0,cooldownUntil:0,lastError:null,safeLogRange:null,pendingLogRange:null});
    return health.get(key);
  };
  const checkBudget=()=>{
    if (now()>=deadline) throw failure('scan_deadline');
    if (requests>=hardLimit) throw failure('scan_rpc_budget');
  };
  const cooling=(entry,group)=>{
    const global=getHealth(entry.id,'all'),local=getHealth(entry.id,group);
    const active=[global,local].filter(value=>value.cooldownUntil>now());
    return active.sort((a,b)=>b.cooldownUntil-a.cooldownUntil)[0];
  };
  const noteFailure=(entry,group,error)=>{
    if (error.terminal || /^scan_/.test(error.code || '')) return;
    const state=getHealth(entry.id,error.code==='rpc_rate_limited'?'all':group);
    state.lastError=error.code;state.failures=Math.min(10,state.failures+1);
    if (error.code==='rpc_finality_unsupported') {
      // An unsupported tag does not disable numbered-header/blockNumber reads.
      // Those are needed for the caller's explicitly labeled depth fallback.
      state.finalityUnsupportedUntil=now()+15*60000;state.cooldownUntil=0;
    } else if (error.code==='rpc_log_range_limited') {
      state.pendingLogRange=Math.max(1,Math.min(MAX_RANGE,error.suggestedRange));
    } else {
      const capability=/archive|access_denied|method_unavailable|log_capability|request_rejected|chain_mismatch|pin_mismatch/.test(error.code);
      const base=error.code==='rpc_rate_limited'?30000:capability?15*60000:5000;
      state.cooldownUntil=now()+Math.max(error.retryAfterMs || 0,Math.min(capability?15*60000:5*60000,base*2**Math.min(4,state.failures-1)));
    }
    if (failures.length<24) failures.push({provider:entry.id,group,code:error.code,cooldownUntil:state.cooldownUntil || null,
      ...(error.suggestedRange?{suggestedRange:error.suggestedRange}:{})});
  };
  const noteSuccess=(entry,group,width)=>{
    const state=getHealth(entry.id,group);state.failures=0;state.lastError=null;state.cooldownUntil=0;
    if (group==='logs' && state.pendingLogRange && width<=state.pendingLogRange) {
      state.safeLogRange=Math.min(width,state.pendingLogRange);state.pendingLogRange=null;
    }
  };
  async function send(entry,method,params) {
    checkBudget();
    const wait=Math.max(0,(nextSend.get(entry.id)||0)-now());
    if (wait>0) {
      if (now()+wait>=deadline) throw failure('scan_deadline');
      await sleep(wait);checkBudget();
    }
    const id=`hookline-project-${++sequence}`;
    requests++;
    // Shared pacing also applies to verification/header calls. Do not burst
    // dozens of per-event header lookups immediately after a successful log read.
    nextSend.set(entry.id,now()+(method==='eth_getLogs'?500:200));
    const controller=new AbortController();let timer;
    const remaining=deadline-now(),timeout=Math.min(8000,remaining);
    const width=method==='eth_getLogs'?numberOf(params[0].toBlock)-numberOf(params[0].fromBlock)+1:undefined;
    try {
      const work=(async()=>{
        const response=await fetchImpl(entry.url,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:controller.signal,redirect:'manual'});
        // Workers supports only manual/follow. Never follow a provider redirect;
        // a non-2xx response is handled as an unavailable source below.
        if (Number(response.headers.get('content-length') || 0)>MAX_BODY_BYTES) throw failure(method==='eth_getLogs'?'rpc_log_range_limited':'rpc_response_too_large',
          method==='eth_getLogs'?{suggestedRange:Math.max(1,Math.floor(width/2))}:{});
        const body=await response.text();
        if (body.length>MAX_BODY_BYTES) throw failure(method==='eth_getLogs'?'rpc_log_range_limited':'rpc_response_too_large',
          method==='eth_getLogs'?{suggestedRange:Math.max(1,Math.floor(width/2))}:{});
        let payload;try {payload=JSON.parse(body);} catch {payload=null;}
        if (!response.ok || payload?.error) throw classifyProjectRpcFailure({status:response.status,message:payload?.error?.message || '',rpcCode:payload?.error?.code,
          method,width,retryAfterMs:retryDelay(response.headers.get('retry-after'),now())});
        if (!payload || payload.jsonrpc!=='2.0' || payload.id!==id || !Object.hasOwn(payload,'result')) throw failure('rpc_response_invalid');
        if (now()>=deadline) throw failure('scan_deadline');
        return payload.result;
      })();
      return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(failure(remaining<=8000?'scan_deadline':'rpc_provider_unavailable'));
      },timeout);})]);
    } catch(error) {
      if (error?.code) throw error;
      throw failure('rpc_provider_unavailable');
    } finally {clearTimeout(timer);}
  }
  const checkChain=async(entry,chainId)=>{
    if (chainVerified.has(entry.id)) return;
    const value=await send(entry,'eth_chainId',[]);
    if (numberOf(value)!==chainId) throw failure('rpc_chain_mismatch');
    chainVerified.add(entry.id);
  };
  const rememberHeader=(entry,value)=>{
    if (value && HASH.test(value.hash || '') && QUANTITY.test(value.number || '')) seenHeaders.set(entry.id,{number:numberOf(value.number),hash:value.hash.toLowerCase()});
  };
  const checkPin=async(entry,chainId)=>{
    const pin=pins.get(chainId);
    if (!pin) throw failure('rpc_pin_required',{terminal:true});
    const key=`${pin.number}:${pin.hash}`;
    if (verifiedPins.get(entry.id)===key) return;
    const value=await send(entry,'eth_getBlockByNumber',[pin.hex,false]);
    if (!value || numberOf(value.number)!==pin.number || value.hash?.toLowerCase()!==pin.hash) throw failure('rpc_pin_mismatch');
    rememberHeader(entry,value);verifiedPins.set(entry.id,key);
  };

  const rpc=async(chainId,method,params=[])=>{
    chainId=Number(chainId);
    const config=PROJECT_RPC_POOLS[chainId];
    if (!config || !METHODS.has(method) || !Array.isArray(params)) throw failure('rpc_method_forbidden',{terminal:true});
    const group=groupFor(method),width=method==='eth_getLogs'?numberOf(params[0]?.toBlock)-numberOf(params[0]?.fromBlock)+1:null;
    if (STATE.has(method)) {
      const blockIndex=method==='eth_getStorageAt'?2:1;
      const n=numberOf(params[blockIndex]),pin=pins.get(chainId);
      if (!pin || n>pin.number) throw failure('rpc_pin_required',{terminal:true});
    }
    if (method==='eth_getLogs' && (!ADDRESS.test(params[0]?.address || '') || !Array.isArray(params[0]?.topics)
      || width<1 || width>MAX_RANGE || !pins.has(chainId) || numberOf(params[0].toBlock)>pins.get(chainId).number)) throw failure('rpc_log_request_invalid',{terminal:true});
    if (method==='eth_getBlockByNumber' && params[0]!=='finalized' && !QUANTITY.test(String(params[0]))) throw failure('rpc_invalid_block',{terminal:true});
    if (method==='eth_getTransactionReceipt' && (!HASH.test(params[0] || '') || !pins.has(chainId))) throw failure('rpc_receipt_request_invalid',{terminal:true});
    if (method==='trace_transaction' && (chainId!==8453 || !HASH.test(params[0] || '') || params.length!==1 || !pins.has(chainId) || !config.traces.length)) {
      throw failure('rpc_trace_request_invalid',{terminal:true});
    }
    const errors=[];
    // Base has a separately verified official receipt/state fallback. Keep the
    // fan-out bounded while allowing that third source to absorb free-tier
    // throttling during receipt catch-up.
    for (const entry of config[group].slice(0,3)) {
      checkBudget();
      const blocked=cooling(entry,group);
      if (blocked) {errors.push(failure(blocked.lastError || 'rpc_provider_unavailable',{retryAfterMs:blocked.cooldownUntil-now()}));continue;}
      const state=getHealth(entry.id,group),range=state.safeLogRange || state.pendingLogRange;
      if (method==='eth_getBlockByNumber' && params[0]==='finalized' && state.finalityUnsupportedUntil>now()) {
        errors.push(failure('rpc_finality_unsupported'));continue;
      }
      if (group==='logs' && range && width>range) {errors.push(failure('rpc_log_range_limited',{suggestedRange:range}));continue;}
      try {
        if (method!=='eth_chainId') await checkChain(entry,Number(chainId));
        const historicalHeader=method==='eth_getBlockByNumber' && params[0]!=='finalized' && pins.has(chainId)
          && numberOf(params[0])!==pins.get(chainId).number;
        if (group==='state' || group==='logs' || group==='traces' || historicalHeader) await checkPin(entry,Number(chainId));
        const value=await send(entry,method,params);
        if (method==='eth_chainId') {
          if (numberOf(value)!==Number(chainId)) throw failure('rpc_chain_mismatch');
          chainVerified.add(entry.id);
        }
        if (method==='eth_getBlockByNumber') {
          if (!value || !HASH.test(value.hash || '') || !QUANTITY.test(value.number || '')) throw failure('rpc_header_unavailable');
          if (params[0]!=='finalized' && numberOf(value.number)!==numberOf(params[0])) throw failure('rpc_header_mismatch');
          const pin=pins.get(Number(chainId));
          if (pin && numberOf(value.number)===pin.number && value.hash.toLowerCase()!==pin.hash) throw failure('rpc_pin_mismatch');
          rememberHeader(entry,value);
        }
        if (method==='eth_getTransactionReceipt' && value && (!HASH.test(value.blockHash || '') || value.transactionHash?.toLowerCase()!==params[0].toLowerCase()
          || numberOf(value.blockNumber)>pins.get(chainId).number)) throw failure('rpc_receipt_mismatch');
        if (method==='trace_transaction') {
          if (!Array.isArray(value) || value.length>4096) throw failure('rpc_trace_invalid');
          for (const item of value) {
            if (!item || !HASH.test(item.blockHash || '') || item.transactionHash?.toLowerCase()!==params[0].toLowerCase()
              || traceNumberOf(item.blockNumber)>pins.get(chainId).number) throw failure('rpc_trace_mismatch');
          }
        }
        noteSuccess(entry,group,width);return value;
      } catch(error) {
        if (error.terminal || /^scan_/.test(error.code || '')) throw error;
        noteFailure(entry,group,error);errors.push(error);
      }
    }
    // A single failing range does not prove all providers have that limit.
    // In particular, never shrink a query because another source is throttled.
    const priority=['rpc_rate_limited','rpc_pin_mismatch','rpc_chain_mismatch','rpc_provider_unavailable','rpc_archive_unavailable','rpc_access_denied','rpc_log_capability_unavailable'];
    for (const code of priority) {const error=errors.find(e=>e.code===code);if(error) throw error;}
    if (errors.length && errors.every(e=>e.code==='rpc_log_range_limited')) throw failure('rpc_log_range_limited',{suggestedRange:Math.max(...errors.map(e=>e.suggestedRange))});
    if (errors.length && errors.every(e=>e.code==='rpc_finality_unsupported')) throw failure('rpc_finality_unsupported');
    throw errors[0] || failure('rpc_provider_unavailable');
  };
  rpc.pinBlock=(chainId,block)=>{
    if (!PROJECT_RPC_POOLS[chainId] || !HASH.test(block?.hash || '')) throw failure('rpc_pin_invalid');
    const number=numberOf(block.number),hash=block.hash.toLowerCase(),old=pins.get(Number(chainId));
    if (old && (old.number!==number || old.hash!==hash)) throw failure('rpc_pin_changed');
    pins.set(Number(chainId),{number,hash,hex:block.number});
    for (const [id,seen] of seenHeaders) if (seen.number===number && seen.hash===hash) verifiedPins.set(id,`${number}:${hash}`);
  };
  rpc.suggestedLogRange=(chainId,cap)=>{
    const ranges=(PROJECT_RPC_POOLS[chainId]?.logs || []).filter(entry=>!cooling(entry,'logs')).map(entry=>{
      const state=getHealth(entry.id,'logs');return Math.min(cap,state.safeLogRange || state.pendingLogRange || cap);
    });
    return ranges.length?Math.max(...ranges):cap;
  };
  rpc.upstreamRequests=()=>requests;
  return {rpc,diagnostics:()=>({requests,maxRequests:hardLimit,deadlineAt:deadline,budgetReached:requests>=hardLimit || now()>=deadline,
    failures:[...failures],providers:[...new Map(Object.values(PROJECT_RPC_POOLS).flatMap(groups=>GROUPS.flatMap(group=>groups[group])).map(entry=>[entry.id,entry])).values()]
      .flatMap(entry=>['all',...GROUPS].filter(group=>health.has(`${entry.id}:${group}`)).map(group=>({provider:entry.id,group,...getHealth(entry.id,group)})))})};
}
