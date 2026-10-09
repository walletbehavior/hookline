import { decodeEventLog, encodeFunctionData, parseAbiItem, toEventSelector } from 'viem';
import { READERS, readerDefinitionsForDeployment } from './reader-definitions.js';

export const SCAN_LIMIT = 6;
export const LOG_BLOCK_LIMIT = 480;
export const RETENTION_DAYS = 30;
export const LOG_PAGE_LIMIT = 4;
export const LOG_ATTEMPT_LIMIT = 8;
export const RPC_CALL_LIMIT = 240;
export const EVENT_WRITE_LIMIT = 160;
export const CONFIG_READ_LIMIT = 12;
export const RECEIPT_PROOF_LIMIT = 4;
export const EVENT_PAGE_READ_LIMIT = 64;
export const CHAIN_LOG_RANGES = Object.freeze({1:2000,56:2000,8453:480,42161:8000,4663:8000});
const ALERT_MAX_AGE_MS = 60 * 60000;
const SCAN_WALL_LIMIT_MS = 42000;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const SUPPORTED = new Set([1,56,8453,42161,4663]);
const DAY = 86400000;
const GENERIC_EVENTS = [
  {key:'implementation_upgrade',label:'Implementation upgraded',signature:'event Upgraded(address indexed implementation)',classification:'configuration',sourceUrl:'https://eips.ethereum.org/EIPS/eip-1967'},
  {key:'ownership_transfer',label:'Owner changed',signature:'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',classification:'configuration',sourceUrl:'https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable'},
];
const json = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const parsed = row => row ? JSON.parse(row.payload_json) : null;
export async function digest(value) {
  const bytes = typeof value==='string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function resultAddress(hex) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(hex))) throw new Error('address_result_invalid');
  if (!/^0{24}/.test(hex.slice(2))) throw new Error('address_result_overflow');
  return `0x${hex.slice(-40).toLowerCase()}`;
}
function quantity(value) {
  if (!/^0x[0-9a-f]+$/i.test(String(value))) throw new Error('invalid_rpc_quantity');
  const n=Number(BigInt(value)); if (!Number.isSafeInteger(n)) throw new Error('quantity_overflow'); return n;
}
const boundedLimit = (value,max,fallback=max) => Number.isFinite(Number(value)) ? Math.max(0,Math.min(max,Math.trunc(Number(value)))) : fallback;
function readAbi(read) {
  if (!['bool','address','uint24','uint256'].includes(read.returns)) throw new Error('reader_return_type_unsupported');
  const type=read.returns;
  return parseAbiItem(`function ${read.signature} view returns (${type})`);
}
function blockSummary(observation) {
  return {id:observation.id,blockNumber:observation.blockNumber,blockHash:observation.blockHash,
    observedAt:observation.observedAt,fields:observation.fields};
}

export async function observeDeployment(project, deployment, {rpc,now=Date.now(),block}) {
  const chainId=deployment.chainId, address=deployment.address.toLowerCase();
  if (!SUPPORTED.has(chainId)||!ADDRESS.test(address)) throw new Error('unsupported_observation_target');
  if (!block || !HASH.test(block.hash)) throw new Error('missing_pinned_block');
  const blockNumber=quantity(block.number), probes={}, fields={}, fieldMeta={};
  const read=async(key,label,fn,meta={})=> {
    fieldMeta[key]={label,classification:'direct_observation',...meta};
    try {fields[key]=await fn();probes[key]={status:'observed'};}
    catch(error) {
      if (/^scan_(rpc_budget|deadline)$/.test(error?.message || '')) throw error;
      fields[key]=null;probes[key]={status:'unavailable',...(error?.message==='reader_implementation_mismatch'?{reason:error.message}:{})};
    }
  };
  const code=await rpc(chainId,'eth_getCode',[address,block.number]);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(String(code))) throw new Error('deployed_code_unavailable');
  const bytes=Uint8Array.from(code.slice(2).match(/../g),x=>parseInt(x,16));
  fields.runtimeFingerprint=await digest(bytes); fields.bytecodeLength=bytes.length;
  probes.runtimeFingerprint=probes.bytecodeLength={status:'observed'};
  fieldMeta.runtimeFingerprint={label:'Runtime SHA-256',classification:'direct_observation'};
  fieldMeta.bytecodeLength={label:'Runtime bytes',classification:'direct_observation',unit:'bytes'};
  await read('implementation','EIP-1967 implementation',async()=>resultAddress(await rpc(chainId,'eth_getStorageAt',[address,SLOT,block.number])),{zeroLabel:'No EIP-1967 implementation in this slot'});
  await read('owner','owner() response',async()=>resultAddress(await rpc(chainId,'eth_call',[{to:address,data:'0x8da5cb5b'},block.number])));
  const readLimit=boundedLimit(READERS[project.id]?.maxReads ?? 6,CONFIG_READ_LIMIT,6);
  for (const definition of readerDefinitionsForDeployment(project.id,deployment).reads.slice(0,readLimit)) {
    const target=definition.address || address;
    if (!ADDRESS.test(target)) continue;
    await read(definition.key,definition.label,async()=>{
      if (definition.implementationAddress && fields.implementation?.toLowerCase()!==definition.implementationAddress.toLowerCase()) throw new Error('reader_implementation_mismatch');
      const abi=readAbi(definition);
      const data=encodeFunctionData({abi:[abi],functionName:abi.name,args:[]});
      const raw=await rpc(chainId,'eth_call',[{to:target,data},block.number]);
      if (definition.returns==='address') return resultAddress(raw);
      if (!/^0x[0-9a-f]{64}$/i.test(String(raw))) throw new Error('config_result_invalid');
      if (definition.returns==='bool') {
        if (![0n,1n].includes(BigInt(raw))) throw new Error('bool_result_invalid');
        return BigInt(raw)===1n;
      }
      if (definition.returns==='uint24' && BigInt(raw)>0xffffffn) throw new Error('uint24_result_overflow');
      return BigInt(raw).toString();
    },{classification:definition.classification || 'configuration',unit:definition.unit || null,
      zeroLabel:definition.zeroLabel || null,asset:definition.asset || null,basis:definition.basis || null,
      denominator:definition.denominator || null,
      returns:definition.returns,sourceVersion:definition.sourceVersion || null,
      implementationAddress:definition.implementationAddress || null,
      description:definition.description || null,sourceUrl:definition.sourceUrl || READERS[project.id]?.sources?.[0]?.url || null});
  }
  // A numbered read must still refer to the pinned hash when collection ends.
  const confirmed=await rpc(chainId,'eth_getBlockByNumber',[block.number,false]);
  if (String(confirmed?.hash).toLowerCase()!==block.hash.toLowerCase()) throw new Error('source_block_changed');
  const id=await digest(`${project.id}:${chainId}:${address}:${block.hash}`);
  return {id,projectId:project.id,chainId,address,blockNumber,blockHash:block.hash.toLowerCase(),
    observedAt:new Date(now).toISOString(),blockTimestamp:new Date(quantity(block.timestamp)*1000).toISOString(),
    finality:block.finality,source:'Hookline direct chain RPC',readerVersion:READERS[project.id]?.version || 'generic-1',
    status:'observed',fields,probes,fieldMeta};
}

export function observationChanges(previous,current) {
  if (!previous || previous.chainId!==current.chainId || previous.address!==current.address || previous.blockNumber>=current.blockNumber) return [];
  return Object.keys(current.fields).filter(key=>key!=='bytecodeLength'
    && current.probes[key]?.status==='observed' && previous.probes[key]?.status==='observed'
    && current.fields[key]!==previous.fields[key]
    && (current.fieldMeta[key]?.classification || '')!=='accrued').map(key=>({key,
      title:`${current.fieldMeta[key]?.label || key} changed`,before:previous.fields[key],after:current.fields[key]}));
}

export const PROJECT_SIGNAL_TYPES=Object.freeze(['all','factory_launch','implementation_change','fee_configuration_change','runtime_change','configuration_change','outcome']);

export function projectEventSignal(event) {
  if(PROJECT_SIGNAL_TYPES.includes(event?.signalType) && event.signalType!=='all') return event.signalType;
  const key=String(event?.field || event?.kind || '').toLowerCase();
  const title=String(event?.title || '').toLowerCase();
  const classification=String(event?.classification || '').toLowerCase();
  if(key==='implementation' || key==='implementation_upgrade' || /implementation.+(?:changed|upgraded)/.test(title)) return 'implementation_change';
  if(key==='runtimefingerprint' || key==='runtime_change' || /runtime (?:bytecode |fingerprint )?(?:changed|appeared)/.test(title)) return 'runtime_change';
  if((event?.deploymentField || event?.hookField) && ['executed','transferred'].includes(classification)
    && /launch|deploy|creat|open/.test(`${key} ${title}`)) return 'factory_launch';
  if(['configuration','configured','direct_observation'].includes(classification)
    && /fee|charge|allocation|recipient|treasury/.test(`${key} ${title}`)) return 'fee_configuration_change';
  if(['configuration','configured','direct_observation'].includes(classification)) return 'configuration_change';
  return 'outcome';
}

export function projectSignalLabel(signal) {
  return ({factory_launch:'Factory launch',implementation_change:'Implementation change',fee_configuration_change:'Fee configuration',
    runtime_change:'Runtime change',configuration_change:'Configuration change',outcome:'Observed outcome'})[signal] || 'Observed change';
}

export async function latestProjectObservations(env,projectId) {
  if (!env.DB) return [];
  const rows=await env.DB.prepare(`SELECT o.payload_json FROM project_observations o
    WHERE o.project_id=? AND o.canonical=1 AND NOT EXISTS (SELECT 1 FROM project_observations n
      WHERE n.project_id=o.project_id AND n.chain_id=o.chain_id AND n.address=o.address AND n.canonical=1 AND n.block_number>o.block_number)
    ORDER BY o.observed_at DESC LIMIT 40`).bind(projectId).all();
  return (rows.results || []).map(parsed);
}
const ACTIVITY_FOCUS = Object.freeze({
  important:['configuration','configured','direct_observation','executed','transferred','deferred'],
  configuration:['configuration','configured','direct_observation'],
  outcome:['executed','transferred','deferred'],
  accrual:['accrued'],
});

export async function listProjectEvents(env,projectId=null,limit=60,{focus='all',history='all',signal='all'}={}) {
  if (!env.DB) return [];
  limit=boundedLimit(limit,100,60);
  if (!limit) return [];
  if(!['all',...Object.keys(ACTIVITY_FOCUS)].includes(focus) || !['all','current'].includes(history)
    || !PROJECT_SIGNAL_TYPES.includes(signal)) throw new Error('project_activity_filter_invalid');
  const where=['canonical=1'],values=[];
  if(projectId){where.push('project_id=?');values.push(projectId);}
  if(focus!=='all') {
    const classes=ACTIVITY_FOCUS[focus],marks=classes.map(()=>'?').join(',');
    where.push(`COALESCE(json_extract(payload_json,'$.classification'),'') IN (${marks})`);values.push(...classes);
  }
  if(history==='current') where.push("COALESCE(json_extract(payload_json,'$.evidence.backfill'),0)=0");
  values.push(signal==='all'?limit:Math.min(300,Math.max(limit*5,100)));
  const statement=env.DB.prepare(`SELECT payload_json FROM project_events WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(occurred_at,observed_at) DESC,observed_at DESC,id DESC LIMIT ?`).bind(...values);
  const events=((await statement.all()).results || []).map(parsed).filter(Boolean).map(event=>({...event,signalType:projectEventSignal(event)}));
  return (signal==='all'?events:events.filter(event=>event.signalType===signal)).slice(0,limit);
}

/** Exact rolling-window totals for the public change feed. The feed itself is
 * deliberately row-bounded; this grouped summary keeps a busy factory from
 * making the visible 60 records look like the whole day. Historical backfill
 * is excluded so baseline ingestion never becomes apparent new activity.
 */
export async function projectActivitySummary(env,projectId=null,{now=Date.now(),hours=24,maxGroups=2000}={}) {
  const emptySignals=Object.fromEntries(PROJECT_SIGNAL_TYPES.filter(value=>value!=='all').map(value=>[value,0]));
  const window={hours,from:new Date(now-hours*60*60*1000).toISOString(),to:new Date(now).toISOString()};
  if(!env.DB) return {window,totalEvents:0,activeProjects:0,signals:emptySignals,projects:[],complete:true,latestAt:null};
  const where=['canonical=1',"COALESCE(json_extract(payload_json,'$.evidence.backfill'),0)=0",'COALESCE(occurred_at,observed_at)>=?'],values=[now-hours*60*60*1000];
  if(projectId){where.push('project_id=?');values.push(projectId);}
  const cap=Math.max(1,Math.min(5000,Math.trunc(Number(maxGroups)||2000)));
  values.push(cap+1);
  const result=await env.DB.prepare(`SELECT project_id,kind,
      json_extract(payload_json,'$.projectName') AS project_name,
      json_extract(payload_json,'$.signalType') AS signal_type,
      json_extract(payload_json,'$.field') AS field,
      json_extract(payload_json,'$.classification') AS classification,
      json_extract(payload_json,'$.title') AS title,
      json_extract(payload_json,'$.deploymentField') AS deployment_field,
      json_extract(payload_json,'$.hookField') AS hook_field,
      COUNT(*) AS events,MAX(COALESCE(occurred_at,observed_at)) AS latest_at
    FROM project_events WHERE ${where.join(' AND ')}
    GROUP BY project_id,kind,project_name,signal_type,field,classification,title,deployment_field,hook_field
    ORDER BY latest_at DESC LIMIT ?`).bind(...values).all();
  const groups=result.results || [],complete=groups.length<=cap,signals={...emptySignals},projects=new Map();
  let totalEvents=0,latestAt=null;
  for(const row of groups.slice(0,cap)) {
    const count=Math.max(0,Number(row.events)||0),signal=projectEventSignal({signalType:row.signal_type,kind:row.kind,field:row.field,
      classification:row.classification,title:row.title,deploymentField:row.deployment_field,hookField:row.hook_field});
    totalEvents+=count;signals[signal]=(signals[signal]||0)+count;
    const latest=Number(row.latest_at);if(Number.isFinite(latest)) latestAt=Math.max(latestAt||0,latest);
    if(!projects.has(row.project_id)) projects.set(row.project_id,{projectId:row.project_id,projectName:row.project_name || row.project_id,totalEvents:0,signals:{...emptySignals},latestAt:null});
    const project=projects.get(row.project_id);project.totalEvents+=count;project.signals[signal]=(project.signals[signal]||0)+count;
    if(Number.isFinite(latest) && (!project.latestAt || latest>Date.parse(project.latestAt))) project.latestAt=new Date(latest).toISOString();
  }
  return {window,totalEvents,activeProjects:projects.size,signals,
    projects:[...projects.values()].sort((left,right)=>right.totalEvents-left.totalEvents || left.projectName.localeCompare(right.projectName)),
    complete,latestAt:latestAt==null?null:new Date(latestAt).toISOString()};
}

export async function projectMonitoring(env,projectId,currentDeployments=null) {
  const limits={configTargetsPerRun:SCAN_LIMIT,maxConfigReadsPerTarget:CONFIG_READ_LIMIT,maxReceiptProofsPerRun:RECEIPT_PROOF_LIMIT,
    eventPagesPerTarget:LOG_PAGE_LIMIT,maxEventPageReads:EVENT_PAGE_READ_LIMIT,maxRpcCalls:RPC_CALL_LIMIT,maxContractEventsPerRun:EVENT_WRITE_LIMIT,
    maxScanSeconds:SCAN_WALL_LIMIT_MS/1000,chainBlockRanges:CHAIN_LOG_RANGES};
  if (!env.DB) return {status:'not_started',targets:[],limits};
  const prefix=`${projectId}:`;
  const rows=(await env.DB.prepare('SELECT * FROM project_scan_state WHERE substr(target,1,length(?))=? ORDER BY target')
    .bind(prefix,prefix).all()).results || [];
  const iso=value=>value==null?null:new Date(Number(value)).toISOString();
  const currentTargets=Array.isArray(currentDeployments) ? new Set(currentDeployments.filter(item=>item?.monitor===true)
    .map(item=>`${Number(item.chainId)}:${String(item.address || '').toLowerCase()}`)) : null;
  const targets=rows.map(row=>{
    const [,chain,address]=row.target.split(':');
    return {chainId:Number(chain),address,lastCheckedAt:iso(row.last_checked_at),lastObservationAt:iso(row.last_success_at),
      eventCheckedAt:iso(row.log_checked_at),eventSuccessAt:iso(row.log_success_at),eventCursorBlock:row.log_cursor ?? null,
      eventTipBlock:row.log_tip ?? null,eventLagBlocks:row.log_lag_blocks ?? null,eventStatus:row.log_status || 'not_started',
      eventCoverageStartBlock:row.log_coverage_start ?? null,eventThroughAt:iso(row.log_cursor_timestamp),
      observationFailure:row.failure || null,eventFailure:row.log_failure || null};
  }).filter(target=>!currentTargets || currentTargets.has(`${target.chainId}:${target.address.toLowerCase()}`));
  const status=!targets.length?'not_started':targets.some(target=>target.observationFailure || target.eventFailure
    || !target.lastObservationAt || Date.now()-Date.parse(target.lastCheckedAt)>ALERT_MAX_AGE_MS)?'partial'
    :targets.some(target=>target.eventStatus!=='caught_up')?'behind':'current';
  return {status,targets,limits};
}

async function saveObservation(env,project,current) {
  const previous=parsed(await env.DB.prepare('SELECT payload_json FROM project_observations WHERE project_id=? AND chain_id=? AND address=? AND canonical=1 ORDER BY block_number DESC LIMIT 1')
    .bind(project.id,current.chainId,current.address).first());
  const statements=[env.DB.prepare(`INSERT INTO project_observations(id,project_id,chain_id,address,block_number,block_hash,observed_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical=1,observed_at=excluded.observed_at,payload_json=excluded.payload_json`).bind(current.id,project.id,current.chainId,current.address,current.blockNumber,current.blockHash,Date.parse(current.observedAt),json(current))];
  for (const change of observationChanges(previous,current)) {
    const id=await digest(`${current.id}:${change.key}`);
    const event={id,projectId:project.id,projectName:project.name,kind:'observed_change',title:change.title,
      observedAt:current.observedAt,chainId:current.chainId,address:current.address,
      before:change.before,after:change.after,field:change.key,classification:current.fieldMeta[change.key]?.classification,
      unit:current.fieldMeta[change.key]?.unit || null,asset:current.fieldMeta[change.key]?.asset || null,
      fieldMeta:current.fieldMeta[change.key],
      evidence:{scope:'between pinned observations',backfill:Date.parse(previous.blockTimestamp || previous.observedAt)<Date.parse(current.observedAt)-ALERT_MAX_AGE_MS,
        fromBlock:previous.blockNumber,toBlock:current.blockNumber,
        fromTimestamp:previous.blockTimestamp || previous.observedAt,toTimestamp:current.blockTimestamp,
        before:blockSummary(previous),after:blockSummary(current),source:current.source,readerVersion:current.readerVersion}};
    event.signalType=projectEventSignal(event);
    statements.push(eventInsert(env,event,current.blockNumber,current.blockHash));
  }
  await env.DB.batch(statements);
}
function eventInsert(env,event,number,hash) {
  const occurred=event.occurredAt ? Date.parse(event.occurredAt) : null;
  const notificationTime=Date.parse(event.evidence?.fromTimestamp || event.occurredAt || event.observedAt);
  return env.DB.prepare(`INSERT INTO project_events(id,project_id,chain_id,address,block_number,block_hash,observed_at,kind,payload_json,occurred_at,notification_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical=1,payload_json=excluded.payload_json,occurred_at=excluded.occurred_at,notification_at=excluded.notification_at WHERE project_events.canonical=0`)
    .bind(event.id,event.projectId,event.chainId,event.address,number,hash,Date.parse(event.observedAt),event.kind,json(event),occurred,notificationTime);
}

const TRANSFER_TOPIC=toEventSelector(parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'));
const UPGRADED_TOPIC=toEventSelector(parseAbiItem(GENERIC_EVENTS[0].signature));
/** A contract report and a matching transfer in the same successful receipt
 * are different evidence levels. This confirms the narrow transfer only, not
 * its price, economic benefit, lifetime total, or circulating-supply accounting.
 */
export function verifyEventReceiptProof({definition,eventLog,receipt,args}) {
  const spec=definition.receiptProof;
  const unconfirmed=reason=>({status:'contract_reported',kind:spec?.kind || null,reason});
  if (spec?.kind!=='erc20_transfer' || ![spec.token,spec.from,spec.to].every(value=>ADDRESS.test(value || ''))
    || !/^\d+$/.test(String(args?.[spec.amountField])) || BigInt(args[spec.amountField])<=0n) return unconfirmed('proof_definition_unavailable');
  if (!receipt || receipt.status!=='0x1' || receipt.transactionHash?.toLowerCase()!==eventLog.transactionHash.toLowerCase()
    || receipt.blockHash?.toLowerCase()!==eventLog.blockHash.toLowerCase()
    || receipt.blockNumber?.toLowerCase()!==eventLog.blockNumber.toLowerCase() || !Array.isArray(receipt.logs)) return unconfirmed('receipt_not_confirmed');
  const source=receipt.logs.find(log=>!log.removed && log.logIndex===eventLog.logIndex
    && log.transactionHash?.toLowerCase()===receipt.transactionHash.toLowerCase() && log.blockHash?.toLowerCase()===receipt.blockHash.toLowerCase()
    && log.address?.toLowerCase()===eventLog.address.toLowerCase() && log.data?.toLowerCase()===eventLog.data.toLowerCase()
    && json(log.topics?.map(value=>value.toLowerCase()))===json(eventLog.topics.map(value=>value.toLowerCase())));
  if (!source) return unconfirmed('source_event_not_in_receipt');
  const transfer=receipt.logs.find(log=>{
    if (log.removed || log.address?.toLowerCase()!==spec.token.toLowerCase() || log.topics?.[0]?.toLowerCase()!==TRANSFER_TOPIC.toLowerCase()
      || log.transactionHash?.toLowerCase()!==receipt.transactionHash.toLowerCase() || log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()
      || log.topics.length!==3 || !HASH.test(log.data || '') || !QUANTITY_PATTERN.test(log.logIndex || '')) return false;
    try {return resultAddress(log.topics[1])===spec.from.toLowerCase() && resultAddress(log.topics[2])===spec.to.toLowerCase()
      && BigInt(log.data)===BigInt(args[spec.amountField]);} catch {return false;}
  });
  if (!transfer) return unconfirmed('matching_transfer_unavailable');
  return {status:'transfer_confirmed',kind:spec.kind,transactionHash:receipt.transactionHash.toLowerCase(),blockHash:receipt.blockHash.toLowerCase(),
    sourceLogIndex:quantity(source.logIndex),transferLogIndex:quantity(transfer.logIndex),token:spec.token.toLowerCase(),
    from:spec.from.toLowerCase(),to:spec.to.toLowerCase(),amount:String(args[spec.amountField]),unit:'raw-token-units'};
}
const QUANTITY_PATTERN=/^0x[0-9a-f]+$/i;

function logFailure(error) {
  const code=error?.code || error?.message || '';
  if (/^scan_(rpc_budget|event_budget|deadline)$/.test(code)) return error;
  if (code==='rpc_rate_limited' || code==='event_rate_limited' || /HTTP 429|rate.?limit|too many requests/i.test(code)) return new Error('event_rate_limited');
  if (code==='rpc_log_range_limited') return Object.assign(new Error('event_range_limited'),{suggestedRange:error.suggestedRange});
  if (code==='event_range_exceeds_budget') return error;
  return new Error('event_provider_unavailable');
}

async function scanLogs(env,project,deployment,{rpc,block,now,state,budget}) {
  const definitions=[...GENERIC_EVENTS,...readerDefinitionsForDeployment(project.id,deployment).events.slice(0,8)];
  const topics=definitions.map(d=>toEventSelector(parseAbiItem(d.signature)));
  const byTopic=new Map(topics.map((t,i)=>[t.toLowerCase(),definitions[i]]));
  const tip=quantity(block.number), target=`${project.id}:${deployment.chainId}:${deployment.address}`;
  const range=CHAIN_LOG_RANGES[deployment.chainId] || LOG_BLOCK_LIMIT;
  let cursor=state?.log_cursor, notificationAfter=state?.notification_after_block;
  let coverageStart=state?.log_coverage_start;
  await env.DB.prepare('UPDATE project_scan_state SET log_checked_at=?,log_tip=?,log_status=? WHERE target=?')
    .bind(now,tip,'scanning',target).run();
  if (cursor!=null && !HASH.test(state?.cursor_hash || '')) throw new Error('event_cursor_hash_unavailable');
  if (cursor!=null && state.cursor_hash) {
    const previousBlock=await rpc(deployment.chainId,'eth_getBlockByNumber',[`0x${cursor.toString(16)}`,false]);
    if (!HASH.test(previousBlock?.hash || '')) throw new Error('event_cursor_header_unavailable');
    if (previousBlock.hash.toLowerCase()!==state.cursor_hash.toLowerCase()) {
      // No verified common ancestor is stored. Quarantine the branch rather
      // than pretending a fixed-depth rewind proves older records canonical.
      // Retain the audit trail and rebuild a bounded recent window silently.
      await env.DB.prepare('UPDATE project_events SET canonical=0 WHERE project_id=? AND chain_id=? AND address=?')
        .bind(project.id,deployment.chainId,deployment.address).run();
      await env.DB.prepare('UPDATE project_scan_state SET log_cursor=NULL,cursor_hash=NULL,log_coverage_start=NULL,log_cursor_timestamp=NULL,notification_after_block=NULL WHERE target=?')
        .bind(target).run();
      cursor=null; notificationAfter=null; coverageStart=null;
    }
  }
  if (cursor>tip) throw new Error('event_head_behind_cursor');
  let from=cursor==null ? Math.max(0,tip-range+1) : cursor+1;
  coverageStart ??= from;
  notificationAfter ??= tip;
  let width=boundedLimit(rpc.suggestedLogRange?.(deployment.chainId,range) ?? range,range,range) || range,pages=0,attempts=0;
  while (from<=tip && pages<LOG_PAGE_LIMIT && attempts<LOG_ATTEMPT_LIMIT) {
    if (budget.eventsRemaining<=0) throw new Error('scan_event_budget');
    const to=Math.min(tip,from+width-1);
    let logs;
    attempts++;
    try {
      logs=await rpc(deployment.chainId,'eth_getLogs',[{address:deployment.address,
        fromBlock:`0x${from.toString(16)}`,toBlock:`0x${to.toString(16)}`,topics:[topics]}]);
      if (!Array.isArray(logs)) throw new Error('event_response_invalid');
      if (logs.length>Math.min(160,budget.eventsRemaining) || json(logs).length>524288) throw new Error('event_range_exceeds_budget');
      const eventBlocks=new Set(logs.map(log=>log.blockNumber));
      const gatedBlocks=new Set(logs.filter(log=>byTopic.get(log.topics?.[0]?.toLowerCase())?.implementationAddress).map(log=>log.blockNumber));
      const proofCount=Math.min(budget.receiptsRemaining,logs.filter(log=>byTopic.get(log.topics?.[0]?.toLowerCase())?.receiptProof).length);
      // Small log arrays can still require hundreds of header/implementation
      // reads. Subdivide that legitimate workload before spending the page's
      // budget, so one dense history window cannot fail forever at the same end.
      if (eventBlocks.size+gatedBlocks.size*2+proofCount+2>EVENT_PAGE_READ_LIMIT) throw new Error('event_range_exceeds_budget');
    } catch (error) {
      const classified=logFailure(error);
      // Only an explicit provider range/result limit or our own write budget
      // justifies a smaller window. A 429, access denial, timeout, or misleading
      // provider error is a visible pause, never a shrinking retry storm.
      if (!['event_range_limited','event_range_exceeds_budget'].includes(classified.message)) throw classified;
      if (to===from || attempts>=LOG_ATTEMPT_LIMIT) throw new Error('event_range_unavailable');
      width=Math.max(1,Math.min(to-from,Number(classified.suggestedRange) || Math.floor((to-from+1)/2)));
      continue;
    }
    const headers=new Map();
    const implementations=new Map();
    const implementation=async(number)=>{
      if (!implementations.has(number)) {
        const value=resultAddress(await rpc(deployment.chainId,'eth_getStorageAt',[deployment.address,SLOT,`0x${number.toString(16)}`]));
        implementations.set(number,value);
      }
      return implementations.get(number);
    };
    const header=async(number)=>{
      if (!headers.has(number)) {
        const value=await rpc(deployment.chainId,'eth_getBlockByNumber',[`0x${number.toString(16)}`,false]);
        if (!HASH.test(value?.hash || '')) throw new Error('event_block_header_unavailable');
        quantity(value.timestamp);
        headers.set(number,value);
      }
      return headers.get(number);
    };
    const pending=[];
    for (const log of logs) {
      if (log.removed || log.address?.toLowerCase()!==deployment.address.toLowerCase()
        || !HASH.test(log.transactionHash || '') || !HASH.test(log.blockHash || '')) throw new Error('event_log_invalid');
      const n=quantity(log.blockNumber); if (n<from || n>to) throw new Error('event_outside_requested_range');
      const definition=byTopic.get(log.topics?.[0]?.toLowerCase());
      if (!definition) throw new Error('event_topic_unexpected');
      const logHeader=await header(n);
      if (logHeader.hash.toLowerCase()!==log.blockHash.toLowerCase()) throw new Error('event_branch_changed');
      const occurredMs=quantity(logHeader.timestamp)*1000;
      let interpreted=true;
      if (definition.implementationAddress) {
        // A current proxy slot does not certify historical event semantics.
        // Check both boundaries of this event's block. An upgrade in the same
        // block remains uninterpreted, even if it changed away and back.
        const expected=definition.implementationAddress.toLowerCase();
        interpreted=await implementation(n)===expected && await implementation(Math.max(0,n-1))===expected
          && !logs.some(candidate=>candidate.blockNumber?.toLowerCase()===log.blockNumber.toLowerCase()
            && candidate.topics?.[0]?.toLowerCase()===UPGRADED_TOPIC.toLowerCase());
      }
      let args=null;
      if (interpreted) {
        try {args=decodeEventLog({abi:[parseAbiItem(definition.signature)],data:log.data,topics:log.topics,strict:true}).args;}
        catch {throw new Error('event_decode_failed');}
      }
      let receiptProof;
      if (definition.receiptProof && interpreted) {
        receiptProof={status:'contract_reported',kind:definition.receiptProof.kind,reason:'receipt_budget_reached'};
        if (budget.receiptsRemaining>0) {
          budget.receiptsRemaining--;
          try {
            const receipt=await rpc(deployment.chainId,'eth_getTransactionReceipt',[log.transactionHash]);
            receiptProof=verifyEventReceiptProof({definition,eventLog:log,receipt,args});
          } catch(error) {
            if (/^scan_(rpc_budget|deadline)$/.test(error?.message || '')) throw error;
            receiptProof={status:'contract_reported',kind:definition.receiptProof.kind,reason:'receipt_unavailable'};
          }
        }
      }
      const id=await digest(`${project.id}:${deployment.chainId}:${log.transactionHash.toLowerCase()}:${quantity(log.logIndex)}:${log.blockHash.toLowerCase()}`);
      const event={id,projectId:project.id,projectName:project.name,kind:interpreted?definition.key:'uninterpreted_contract_event',title:interpreted?definition.label:'Event from an unverified implementation',
        observedAt:new Date(now).toISOString(),occurredAt:new Date(occurredMs).toISOString(),chainId:deployment.chainId,address:deployment.address,
        before:null,after:interpreted?JSON.parse(json(args)):null,transactionHash:log.transactionHash,blockNumber:n,
        classification:interpreted?definition.classification:'uninterpreted',unit:interpreted?definition.unit || null:null,asset:interpreted?definition.asset || null:null,
        amountField:interpreted?definition.amountField || null:null,recipientField:interpreted?definition.recipientField || null:null,assetField:interpreted?definition.assetField || null:null,
        deploymentField:interpreted?definition.deploymentField || null:null,hookField:interpreted?definition.hookField || null:null,poolField:interpreted?definition.poolField || null:null,
        curveField:interpreted?definition.curveField || null:null,description:interpreted?definition.description || null:null,
        fieldUnits:interpreted?definition.fieldUnits || null:null,
        fieldLabels:interpreted?definition.fieldLabels || null:null,
        fieldValueLabels:interpreted?definition.fieldValueLabels || null:null,
        evidence:{scope:'contract event',backfill:n<=notificationAfter || occurredMs<now-ALERT_MAX_AGE_MS,
          fromBlock:from,toBlock:to,blockHash:log.blockHash,logIndex:quantity(log.logIndex),finality:block.finality,
          signature:definition.signature,source:definition.sourceUrl || READERS[project.id]?.sources?.[0]?.url || 'configured chain RPC',
          sourceVersion:definition.sourceVersion || null,implementationAddress:definition.implementationAddress || null,
          interpretation:interpreted?'source_bound':'implementation_unverified',...(receiptProof?{receiptProof}:{}),
          raw:{topics:log.topics,data:log.data},readerVersion:READERS[project.id]?.version || 'generic-1'}};
      event.signalType=projectEventSignal(event);
      pending.push(eventInsert(env,event,n,log.blockHash));
    }
    const endBlock=await header(to);
    // Re-check after log/header reads, including catch-up pages before the tip.
    const confirmed=await rpc(deployment.chainId,'eth_getBlockByNumber',[`0x${to.toString(16)}`,false]);
    if (confirmed?.hash?.toLowerCase()!==endBlock.hash.toLowerCase()
      || (to===tip && endBlock.hash.toLowerCase()!==block.hash.toLowerCase())) throw new Error('event_branch_changed');
    pending.push(env.DB.prepare(`UPDATE project_scan_state SET log_cursor=?,cursor_hash=?,log_success_at=?,log_failure=NULL,
      log_tip=?,log_lag_blocks=?,log_status=?,log_coverage_start=?,log_cursor_timestamp=?,notification_after_block=? WHERE target=?`)
      .bind(to,endBlock.hash.toLowerCase(),now,tip,Math.max(0,tip-to),to===tip?'caught_up':'behind',coverageStart,
        quantity(endBlock.timestamp)*1000,notificationAfter,target));
    await env.DB.batch(pending);
    budget.eventsRemaining-=logs.length;
    cursor=to;from=to+1;pages++;
  }
  // A budget bound is a visible backlog, never a silent jump to the newest block.
  await env.DB.prepare('UPDATE project_scan_state SET log_failure=NULL,log_lag_blocks=?,log_status=?,log_success_at=? WHERE target=?')
    .bind(Math.max(0,tip-(cursor ?? from-1)),cursor===tip?'caught_up':'behind',now,target).run();
  return {pages,attempts,cursor,tip,lagBlocks:Math.max(0,tip-(cursor ?? from-1))};
}

export async function runProjectScan(env,{registry,rpc:sourceRpc,now=Date.now(),limit=SCAN_LIMIT}) {
  if (!env.DB) return {status:'skipped',reason:'storage_unavailable'};
  limit=boundedLimit(limit,SCAN_LIMIT);
  if (!limit) return {status:'ok',checked:0,failed:0,logFailed:0,rpcCalls:0};
  const started=Date.now();let rpcCalls=0;
  const rpc=async(chainId,method,params)=>{
    const remaining=SCAN_WALL_LIMIT_MS-(Date.now()-started);
    if (remaining<=0) throw new Error('scan_deadline');
    if (rpcCalls>=RPC_CALL_LIMIT) throw new Error('scan_rpc_budget');
    rpcCalls++;
    let timer;
    try {return await Promise.race([sourceRpc(chainId,method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('scan_deadline')),remaining);})]);}
    finally {clearTimeout(timer);}
  };
  rpc.suggestedLogRange=sourceRpc.suggestedLogRange?.bind(sourceRpc);
  const owner=crypto.randomUUID();
  const lease=await env.DB.prepare(`INSERT INTO project_scan_locks(id,owner,lease_until) VALUES('scan',?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE project_scan_locks.lease_until<? RETURNING id`).bind(owner,now+8*60000,now).first();
  if (!lease) return {status:'skipped',reason:'scan_in_progress'};
  let checked=0,failed=0,logFailed=0;
  const failedTargets=[];
  const budget={eventsRemaining:EVENT_WRITE_LIMIT,receiptsRemaining:RECEIPT_PROOF_LIMIT};
  try {
    const states=new Map(((await env.DB.prepare('SELECT * FROM project_scan_state').all()).results || []).map(s=>[s.target,s]));
    const targets=registry.projects.flatMap(project=>project.deployments.filter(d=>d.monitor===true && SUPPORTED.has(d.chainId)).map(deployment=>({project,deployment,target:`${project.id}:${deployment.chainId}:${deployment.address}`})))
      .sort((a,b)=>(states.get(a.target)?.last_checked_at || 0)-(states.get(b.target)?.last_checked_at || 0)).slice(0,limit);
    const heads=new Map();
    for (const {project,deployment,target} of targets) {
      if (rpcCalls>=RPC_CALL_LIMIT || (sourceRpc.upstreamRequests?.() || 0)>=RPC_CALL_LIMIT || Date.now()-started>=SCAN_WALL_LIMIT_MS) break;
      await env.DB.prepare('INSERT INTO project_scan_state(target,last_checked_at) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET last_checked_at=excluded.last_checked_at').bind(target,now).run();
      try {
        let block=heads.get(deployment.chainId);
        if (!block) {
          const id=quantity(await rpc(deployment.chainId,'eth_chainId',[]));
          if (id!==deployment.chainId) throw new Error('rpc_chain_mismatch');
          let unsupportedFinality=false;
          try {block=await rpc(id,'eth_getBlockByNumber',['finalized',false]);} catch(error) {
            // A rate limit or temporary failure must not silently downgrade the
            // finality promise to a much newer 12-block head.
            if (!['rpc_finality_unsupported','unsupported finality'].includes(error?.code || error?.message)) throw error;
            unsupportedFinality=true;
          }
          if (unsupportedFinality) {
            const latest=quantity(await rpc(id,'eth_blockNumber',[]));
            block=await rpc(id,'eth_getBlockByNumber',[`0x${Math.max(0,latest-12).toString(16)}`,false]);
            block={...block,finality:'12-block confirmation depth'};
          } else block={...block,finality:'upstream finalized block'};
          if (!HASH.test(block?.hash || '')) throw new Error('finalized_header_unavailable');
          quantity(block.number);quantity(block.timestamp);
          sourceRpc.pinBlock?.(id,block);
          heads.set(id,block);
        }
        const prior=await env.DB.prepare('SELECT block_number,block_hash FROM project_observations WHERE project_id=? AND chain_id=? AND address=? AND canonical=1 ORDER BY block_number DESC LIMIT 1')
          .bind(project.id,deployment.chainId,deployment.address).first();
        if(prior) {
          const header=await rpc(deployment.chainId,'eth_getBlockByNumber',[`0x${prior.block_number.toString(16)}`,false]);
          if(!header?.hash) throw new Error('previous_source_block_unavailable');
          if(header.hash.toLowerCase()!==prior.block_hash.toLowerCase()) {
            await env.DB.batch([
              env.DB.prepare('UPDATE project_observations SET canonical=0 WHERE project_id=? AND chain_id=? AND address=?').bind(project.id,deployment.chainId,deployment.address),
              env.DB.prepare('UPDATE project_events SET canonical=0 WHERE project_id=? AND chain_id=? AND address=?').bind(project.id,deployment.chainId,deployment.address),
              env.DB.prepare('UPDATE project_scan_state SET log_cursor=NULL,cursor_hash=NULL,log_coverage_start=NULL,log_cursor_timestamp=NULL,notification_after_block=NULL WHERE target=?').bind(target),
            ]);
            states.set(target,{...states.get(target),log_cursor:null,cursor_hash:null,log_coverage_start:null,log_cursor_timestamp:null,notification_after_block:null});
          }
        }
        const observation=await observeDeployment(project,deployment,{rpc,block,now});
        await saveObservation(env,project,observation);
        await env.DB.prepare('UPDATE project_scan_state SET last_success_at=?,failure=NULL WHERE target=?').bind(now,target).run();
        try {await scanLogs(env,project,deployment,{rpc,block,now,state:states.get(target),budget});} catch (error) {
          // Successfully validated earlier pages survive; a failed page never
          // advances its cursor. Log and observation freshness are separate.
          logFailed++;
          const normalized=(error?.code || error?.message || '').startsWith('rpc_')?logFailure(error).message:error?.message;
          const reason=/^(event_[a-z_]+|scan_rpc_budget|scan_event_budget|scan_deadline)$/.test(normalized || '') ? normalized : 'event_scan_unavailable';
          await env.DB.prepare(`UPDATE project_scan_state SET log_failure=?,log_status='unavailable',
            log_lag_blocks=CASE WHEN log_cursor IS NULL THEN NULL ELSE MAX(0,?-log_cursor) END WHERE target=?`)
            .bind(reason,quantity(block.number),target).run();
        }
        checked++;
      } catch (error) {
        failed++;
        // Returned only by the private operator scan. Public profiles retain
        // bounded status codes, never raw provider or database messages.
        failedTargets.push({projectId:project.id,chainId:deployment.chainId,
          reason:String(error?.message || 'observation_unavailable').replace(/[\r\n\t]/g,' ').slice(0,200)});
        const reason=/^(scan_rpc_budget|scan_deadline)$/.test(error?.message || '') ? error.message : 'observation_unavailable';
        await env.DB.prepare('UPDATE project_scan_state SET failure=? WHERE target=?').bind(reason,target).run();
      }
    }
    // Keep the latest successful read even during prolonged upstream failure.
    await env.DB.prepare(`DELETE FROM project_observations WHERE observed_at<? AND id NOT IN
      (SELECT id FROM project_observations o WHERE o.canonical=1 AND NOT EXISTS (SELECT 1 FROM project_observations n WHERE n.project_id=o.project_id AND n.chain_id=o.chain_id AND n.address=o.address AND n.canonical=1 AND n.block_number>o.block_number))`)
      .bind(now-RETENTION_DAYS*DAY).run();
    await env.DB.prepare('DELETE FROM project_events WHERE observed_at<?').bind(now-RETENTION_DAYS*DAY).run();
    await env.DB.prepare('DELETE FROM project_deliveries WHERE attempted_at<?').bind(now-RETENTION_DAYS*DAY).run();
    return {status:'ok',checked,failed,logFailed,rpcCalls,upstreamRpcCalls:sourceRpc.upstreamRequests?.() ?? rpcCalls,
      failedTargets,contractEventsWritten:EVENT_WRITE_LIMIT-budget.eventsRemaining,receiptProofsAttempted:RECEIPT_PROOF_LIMIT-budget.receiptsRemaining,
      budgetReached:rpcCalls>=RPC_CALL_LIMIT || (sourceRpc.upstreamRequests?.() || 0)>=RPC_CALL_LIMIT || budget.eventsRemaining<=0 || Date.now()-started>=SCAN_WALL_LIMIT_MS};
  } finally {
    await env.DB.prepare('UPDATE project_scan_locks SET lease_until=0 WHERE id=? AND owner=?').bind('scan',owner).run();
  }
}

export async function followProject(env,{projectId,userId,chatId,enabled=true,now=Date.now()}) {
  if (!env.DB) throw new Error('Project follows are temporarily unavailable.');
  if (!/^\d+$/.test(String(userId)) || String(userId)!==String(chatId)) throw new Error('Open the bot privately to manage follows.');
  const id=await digest(`${userId}:${chatId}:${projectId}`);
  // Admission and upsert are one SQLite statement. Concurrent subscriptions
  // cannot all pass a stale count, and an already-enabled follow is idempotent.
  const row=await env.DB.prepare(`INSERT INTO project_follows(id,telegram_user_id,chat_id,project_id,created_at,enabled)
    SELECT ?,?,?,?,?,? WHERE ?=0
      OR EXISTS(SELECT 1 FROM project_follows WHERE telegram_user_id=? AND chat_id=? AND project_id=? AND enabled=1)
      OR (SELECT COUNT(*) FROM project_follows WHERE telegram_user_id=? AND enabled=1)<20
    ON CONFLICT(telegram_user_id,chat_id,project_id) DO UPDATE SET enabled=excluded.enabled,
      created_at=CASE WHEN project_follows.enabled=0 AND excluded.enabled=1 THEN excluded.created_at ELSE project_follows.created_at END
    RETURNING project_id`)
    .bind(id,String(userId),String(chatId),projectId,now,enabled?1:0,enabled?1:0,String(userId),String(chatId),projectId,String(userId)).first();
  if (!row) throw new Error('Project follow limit reached (20). Unfollow a project first.');
  return {projectId,enabled};
}
export async function projectFollows(env,userId) {
  if (!env.DB) return [];
  return ((await env.DB.prepare('SELECT project_id FROM project_follows WHERE telegram_user_id=? AND enabled=1 LIMIT 20').bind(String(userId)).all()).results || []).map(r=>r.project_id);
}

function eventDetailLines(event) {
  const format=(value,unit,asset)=>{
    if (value===null) return 'Unavailable';
    if (unit==='wei' && /^\d+$/.test(String(value))) {
      const digits=String(value).padStart(19,'0');
      return `${digits.slice(0,-18)}${digits.slice(-18).replace(/0+$/,'')?`.${digits.slice(-18).replace(/0+$/,'')}`:''} ${asset || 'native units'}`;
    }
    if (unit==='bps' && /^\d+$/.test(String(value))) {
      const digits=String(value).padStart(3,'0');
      return `${digits.slice(0,-2)}.${digits.slice(-2)}%`;
    }
    if (unit==='ppm' && /^\d+$/.test(String(value))) {
      const digits=String(value).padStart(5,'0');
      return `${digits.slice(0,-4)}.${digits.slice(-4).replace(/0+$/,'') || '0'}% (${value} ppm)`;
    }
    return `${String(value).slice(0,100)}${unit==='raw-token-units'?' raw token units':''}`;
  };
  if (event.kind==='observed_change') return [
    `Before: ${format(event.before,event.unit,event.asset)}`,`After: ${format(event.after,event.unit,event.asset)}`,
  ];
  const args=event.after || {}, details=[], used=new Set();
  const add=(label,field)=>{if(field && args[field]!=null){
    const mapped=event.fieldValueLabels?.[field]?.[String(args[field])];
    details.push(`${label}: ${mapped ? `${mapped} (${args[field]})` : format(args[field])}`);used.add(field);
  }};
  if (event.amountField && /^\d+$/.test(String(args[event.amountField]))) {
    details.push(`Amount recorded: ${format(args[event.amountField],event.unit,event.asset)}`);used.add(event.amountField);
  }
  add('Recipient',event.recipientField);add('Token',event.assetField);
  add('Deployment',event.deploymentField);add('Hook',event.hookField);add('Curve',event.curveField);add('Pool',event.poolField);
  for (const [field,label] of [['implementation','Implementation'],['newOwner','New owner'],['mind','Model'],['hook','Hook'],
    ['newTeamFeeRecipient','Fee recipient'],['enabled','Enabled'],['deprecated','Deprecated'],['launchConfigId','Launch config']]) {
    if (!used.has(field)) add(label,field);
  }
  for (const [field,label] of Object.entries(event.fieldLabels || {})) if (!used.has(field)) add(label,field);
  return details.slice(0,4);
}

export async function deliverProjectEvents(env,{send,now=Date.now()}) {
  if (!env.DB) return {sent:0};
  const rows=(await env.DB.prepare(`SELECT f.id AS follow_id,f.chat_id,e.id AS event_id,e.payload_json FROM project_follows f JOIN project_events e ON e.project_id=f.project_id
    LEFT JOIN project_deliveries d ON d.follow_id=f.id AND d.event_id=e.id
    WHERE f.enabled=1 AND e.canonical=1 AND COALESCE(e.notification_at,e.observed_at)>f.created_at AND e.observed_at>? AND d.event_id IS NULL
      AND COALESCE(json_extract(e.payload_json,'$.evidence.backfill'),0)=0
      AND COALESCE(json_extract(e.payload_json,'$.classification'),'')!='accrued'
    ORDER BY e.observed_at ASC LIMIT 25`).bind(now-DAY).all()).results || [];
  let sent=0;
  for (const row of rows) {
    const claimed=await env.DB.prepare('INSERT INTO project_deliveries(follow_id,event_id,status,attempted_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING follow_id')
      .bind(row.follow_id,row.event_id,'sending',now).first();
    if (!claimed) continue;
    const event=parsed(row);
    event.signalType=projectEventSignal(event);
    const evidenceUrl=`https://hookline.world/#/projects/${encodeURIComponent(event.projectId)}`;
    const html=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\b0x[0-9a-f]{40}\b/gi,address=>`<code>${address}</code>`);
    const text=[`${event.projectName}, ${event.title}`,projectSignalLabel(event.signalType),event.evidence.scope==='contract event'?`Chain ${event.chainId}, block ${event.blockNumber}`:`Chain ${event.chainId}, observed between blocks ${event.evidence.fromBlock} and ${event.evidence.toBlock}`,
      ...(ADDRESS.test(event.address)?[`Contract: ${event.address}`]:[]),...eventDetailLines(event),evidenceUrl].map(html).join('\n');
    try {
      await send(row.chat_id,text,{parse_mode:'HTML',disable_web_page_preview:true,
        reply_markup:{inline_keyboard:[[{text:'View evidence',url:evidenceUrl}]]}});
      await env.DB.prepare('UPDATE project_deliveries SET status=?,delivered_at=? WHERE follow_id=? AND event_id=?').bind('delivered',now,row.follow_id,row.event_id).run();sent++;
    } catch {
      // A timeout may have delivered. Do not blindly duplicate notifications.
      await env.DB.prepare('UPDATE project_deliveries SET status=? WHERE follow_id=? AND event_id=?').bind('delivery_uncertain',row.follow_id,row.event_id).run();
    }
  }
  return {sent};
}
