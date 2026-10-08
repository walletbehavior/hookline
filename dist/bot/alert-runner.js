'use strict';

import { TelegramClient } from './bot-api.js';
import { CHAIN_CONFIG } from './chains.js';
import { resolveHookMarkets as fallbackResolver } from './market.js';
import { alertHtml,cleanLabel,alertNavigationRows } from './navigation.js';
import {
  ALERT_CHECK_INTERVAL_MS,
  AlertStorageUnavailableError,
  makeD1AlertStore,
} from './alerts-store.js';

export const SCAN_CAP_PER_RUN = 25;
export const SCAN_CAP_PER_USER = 10;
export const LIQUIDITY_CHANGE_THRESHOLD = 0.10;
export const POOL_FEE_CHANGE_THRESHOLD_RAW = 1000; // 10 basis points

function runtimeFingerprintOf(inspection) {
  const value = inspection?.runtimeFingerprint;
  const fingerprint = typeof value === 'object' ? value?.fingerprint : value;
  return typeof fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(fingerprint)
    ? fingerprint.toLowerCase()
    : null;
}

function normalizeSwapFees(source) {
  if(source?.available!==true || source?.complete!==true || !Array.isArray(source.pools)) return null;
  return source.pools.map((pool)=>({poolId:String(pool?.poolId || '').toLowerCase(),feeRaw:Number(pool?.feeRaw),
    blockNumber:Number(pool?.blockNumber),transactionHash:String(pool?.transactionHash || '').toLowerCase(),logIndex:Number(pool?.logIndex)}))
    .filter((pool)=>/^0x[0-9a-f]{64}$/.test(pool.poolId)&&Number.isInteger(pool.feeRaw)&&pool.feeRaw>=0&&pool.feeRaw<=1_000_000
      &&Number.isSafeInteger(pool.blockNumber)&&/^0x[0-9a-f]{64}$/.test(pool.transactionHash)&&Number.isSafeInteger(pool.logIndex));
}

function marketBaseline(result, inspection = null, firstParty = null, swapFees = null) {
  const markets = Array.isArray(result?.markets) ? result.markets : [];
  const poolIds = [...new Set(markets
    .map((market) => String(market?.pairAddress || market?.poolId || '').toLowerCase())
    .filter(Boolean))].sort();
  const aggregateLiquidityUsd = markets.reduce((sum, market) => {
    const liquidity = Number(market?.liquidityUsd);
    return sum + (Number.isFinite(liquidity) && liquidity > 0 ? liquidity : 0);
  }, 0);
  return {
    poolIds,
    aggregateLiquidityUsd,
    liquidityComplete:markets.length>0 && markets.every(market=>market?.liquidityUsd!=null && Number.isFinite(Number(market.liquidityUsd)) && Number(market.liquidityUsd)>=0),
    runtimeFingerprint: runtimeFingerprintOf(inspection),
    codeByteLength: Number.isSafeInteger(Number(inspection?.codeByteLength)) ? Number(inspection.codeByteLength) : null,
    firstPartyPools:firstParty?.available===true && firstParty?.complete===true && Array.isArray(firstParty.pools)
      ? firstParty.pools.map((pool)=>({poolId:String(pool.poolId || '').toLowerCase(),transactionHash:String(pool.transactionHash || '').toLowerCase(),blockNumber:Number(pool.blockNumber),logIndex:Number(pool.logIndex)}))
        .filter((pool)=>/^0x[0-9a-f]{64}$/.test(pool.poolId)&&/^0x[0-9a-f]{64}$/.test(pool.transactionHash)&&Number.isSafeInteger(pool.blockNumber)&&Number.isSafeInteger(pool.logIndex))
      : null,
    firstPartySwapFees:normalizeSwapFees(swapFees),
  };
}

function parseBaseline(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed?.poolIds)) return null;
    return {
      poolIds: parsed.poolIds.map((item) => String(item).toLowerCase()).sort(),
      aggregateLiquidityUsd: Number(parsed.aggregateLiquidityUsd) || 0,
      liquidityComplete:parsed.liquidityComplete===true,
      runtimeFingerprint: typeof parsed.runtimeFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(parsed.runtimeFingerprint)
        ? parsed.runtimeFingerprint.toLowerCase()
        : null,
      codeByteLength: Number.isSafeInteger(Number(parsed.codeByteLength)) ? Number(parsed.codeByteLength) : null,
      firstPartyPools:Array.isArray(parsed.firstPartyPools)?parsed.firstPartyPools.map((pool)=>({
        poolId:String(pool?.poolId || '').toLowerCase(),transactionHash:String(pool?.transactionHash || '').toLowerCase(),
        blockNumber:Number(pool?.blockNumber),logIndex:Number(pool?.logIndex),
      })).filter((pool)=>/^0x[0-9a-f]{64}$/.test(pool.poolId)&&/^0x[0-9a-f]{64}$/.test(pool.transactionHash)&&Number.isSafeInteger(pool.blockNumber)&&Number.isSafeInteger(pool.logIndex)):null,
      firstPartySwapFees:Array.isArray(parsed.firstPartySwapFees)?normalizeSwapFees({available:true,complete:true,pools:parsed.firstPartySwapFees}):null,
    };
  } catch {
    return null;
  }
}

function money(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: number >= 1_000 ? 0 : 2,
  }).format(number);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function alertEvents(previous, current) {
  if (!previous) return [];
  const knownPools = new Set(previous.poolIds);
  const newPools = current.poolIds.filter((poolId) => !knownPools.has(poolId));
  const events = [];
  if(Array.isArray(previous.firstPartyPools) && Array.isArray(current.firstPartyPools)) {
    const knownFirstParty=new Set(previous.firstPartyPools.map((pool)=>pool.poolId));
    const newFirstParty=current.firstPartyPools.filter((pool)=>!knownFirstParty.has(pool.poolId));
    if(newFirstParty.length) events.push({kind:'first_party_pool',count:newFirstParty.length,pools:newFirstParty,
      eventKey:`first_party_pool:${stableHash(newFirstParty.map((pool)=>pool.poolId).sort().join(','))}`});
  }
  if(Array.isArray(previous.firstPartySwapFees) && Array.isArray(current.firstPartySwapFees)) {
    const prior=new Map(previous.firstPartySwapFees.map((pool)=>[pool.poolId,pool]));
    const changes=current.firstPartySwapFees.map((pool)=>({previous:prior.get(pool.poolId),current:pool}))
      .filter(({previous:before,current:after})=>before && Math.abs(after.feeRaw-before.feeRaw)>=POOL_FEE_CHANGE_THRESHOLD_RAW)
      .slice(0,5);
    if(changes.length) events.push({kind:'pool_fee_change',count:changes.length,changes,
      eventKey:`pool_fee_change:${stableHash(changes.map(({current:pool})=>`${pool.poolId}:${pool.feeRaw}:${pool.blockNumber}:${pool.logIndex}`).sort().join(','))}`});
  }
  if (previous.runtimeFingerprint && current.runtimeFingerprint && previous.runtimeFingerprint !== current.runtimeFingerprint) {
    events.push({
      kind: 'runtime_change',
      previousFingerprint: previous.runtimeFingerprint,
      currentFingerprint: current.runtimeFingerprint,
      eventKey: `runtime:${current.runtimeFingerprint}`,
    });
  }
  if (newPools.length) {
    events.push({
      kind: 'new_pool',
      count: newPools.length,
      eventKey: `new_pool:${stableHash(newPools.join(','))}`,
    });
  }
  const samePools=previous.poolIds.length===current.poolIds.length && current.poolIds.every(id=>knownPools.has(id));
  if (samePools && previous.liquidityComplete===true && current.liquidityComplete===true && previous.aggregateLiquidityUsd > 0) {
    const delta = current.aggregateLiquidityUsd - previous.aggregateLiquidityUsd;
    const ratio = Math.abs(delta) / previous.aggregateLiquidityUsd;
    if (ratio >= LIQUIDITY_CHANGE_THRESHOLD) {
      events.push({
        kind: 'liquidity',
        ratio: delta / previous.aggregateLiquidityUsd,
        eventKey: `liquidity:${stableHash(`${Math.round(previous.aggregateLiquidityUsd)}:${Math.round(current.aggregateLiquidityUsd)}`)}`,
      });
    }
  }
  return events;
}

function formatNotification(alert, event, previous, current,result) {
  const chainName = CHAIN_CONFIG[Number(alert.chain_id)]?.name || `Chain ${alert.chain_id}`;
  const change = event.kind === 'runtime_change'
    ? 'Runtime bytecode changed'
    : event.kind === 'first_party_pool'
      ? `${event.count} new finalized Base pool${event.count === 1 ? '' : 's'}`
    : event.kind === 'pool_fee_change'
      ? `PoolManager fee changed by at least 10 bps in ${event.count} pool${event.count === 1 ? '' : 's'}`
    : event.kind === 'new_pool'
      ? `${event.count} new indexed pool relationship${event.count === 1 ? '' : 's'}`
      : `Indexed liquidity ${event.ratio >= 0 ? 'rose' : 'fell'} ${Math.abs(event.ratio * 100).toFixed(1)}%`;
  const lines = [
    'Hookline alert',
    cleanLabel(result?.profile?.project?.name || result?.profile?.verifiedContract?.name || result?.profile?.verifiedContract?.contractName || result?.hookName || 'Unnamed hook'),
    `${chainName} · Hook changes`,
    {address:alert.target_address},
    change,
  ];
  if (event.kind === 'runtime_change') {
    lines.push(`Runtime: ${event.previousFingerprint.slice(0, 10)}..., ${event.currentFingerprint.slice(0, 10)}...`);
  } else if(event.kind==='first_party_pool' && event.pools?.[0]) {
    lines.push(`Pool: ${event.pools[0].poolId}`);
    lines.push(`Block: ${event.pools[0].blockNumber}`);
    lines.push('Source transaction');
    lines.push({address:event.pools[0].transactionHash});
  } else if(event.kind==='pool_fee_change' && event.changes?.[0]) {
    const {previous:before,current:after}=event.changes[0];
    lines.push(`Pool: ${after.poolId}`);
    lines.push(`Reported swap fee: ${(before.feeRaw/10000).toFixed(4)}%, ${(after.feeRaw/10000).toFixed(4)}%`);
    lines.push(`Block: ${after.blockNumber}`);
    lines.push('Source transaction');
    lines.push({address:after.transactionHash});
  } else if(previous.liquidityComplete && current.liquidityComplete) {
    lines.push(`Indexed liquidity: ${money(previous.aggregateLiquidityUsd)}, ${money(current.aggregateLiquidityUsd)}`);
  }
  return alertHtml(lines);
}

async function defaultSend(env, chatId, text,options) {
  if (!env?.TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot token is unavailable');
  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  return client.sendMessage(chatId, text, options);
}

export async function runAlertScan(env, options = {}) {
  const now = Number(options.now || Date.now());
  let store;
  try {
    store = options.store || makeD1AlertStore(env);
  } catch (error) {
    if (error instanceof AlertStorageUnavailableError) return { status: 'skipped', reason: 'db_unavailable' };
    throw error;
  }

  const resolveHookMarkets = options.resolveHookMarkets || fallbackResolver;
  const inspectHook = options.inspectHook || null;
  const resolveFirstPartyPools=options.resolveFirstPartyPools || null;
  const resolveFirstPartySwapFees=options.resolveFirstPartySwapFees || null;
  const sendMessage = options.sendMessage || ((chatId, text,sendOptions) => defaultSend(env, chatId, text,sendOptions));
  const due = await store.listDueAlerts({
    now,
    limit: SCAN_CAP_PER_RUN,
    perUserLimit: SCAN_CAP_PER_USER,
  });

  let seeded = 0;
  let checked = 0;
  let delivered = 0;
  let failed = 0;

  for (const alert of due) {
    try {
      const [result, inspection, firstParty, swapFees] = await Promise.all([
        resolveHookMarkets(Number(alert.chain_id), String(alert.target_address)),
        inspectHook ? inspectHook(Number(alert.chain_id), String(alert.target_address)) : Promise.resolve(null),
        resolveFirstPartyPools ? Promise.resolve().then(()=>resolveFirstPartyPools(Number(alert.chain_id),String(alert.target_address))).catch(()=>null) : Promise.resolve(null),
        resolveFirstPartySwapFees ? Promise.resolve().then(()=>resolveFirstPartySwapFees(Number(alert.chain_id),String(alert.target_address))).catch(()=>null) : Promise.resolve(null),
      ]);
      const previous = parseBaseline(alert.baseline_json);
      const current = marketBaseline(result, inspection, firstParty, swapFees);
      // Empty/failed market coverage is not evidence that the old pools vanished.
      // Preserve identities for recovery; no liquidity alert uses this read.
      if(previous && !current.poolIds.length) {
        current.poolIds=previous.poolIds;
        current.aggregateLiquidityUsd=previous.aggregateLiquidityUsd;
      }
      if(previous && current.firstPartyPools===null) current.firstPartyPools=previous.firstPartyPools;
      if(previous && current.firstPartySwapFees===null) current.firstPartySwapFees=previous.firstPartySwapFees;
      if (!previous) {
        await store.updateBaseline({ id: alert.id, baseline: current, now });
        seeded += 1;
        checked += 1;
        continue;
      }

      for (const event of alertEvents(previous, current)) {
        if (await store.hasDelivery(alert.id, event.eventKey)) continue;
        await sendMessage(String(alert.chat_id), formatNotification(alert, event, previous, current,result),{
          parse_mode:'HTML',disable_web_page_preview:true,
          reply_markup:{inline_keyboard:[[{text:'Details',url:event.kind==='first_party_pool'?`https://hookline.world/#/tape/pools/${alert.chain_id}/${alert.target_address}`:event.kind==='pool_fee_change'?`https://hookline.world/#/tape/swaps/${alert.chain_id}/${alert.target_address}`:`https://hookline.world/#/board/${alert.chain_id}/${alert.target_address}`},{text:'Pause alert',callback_data:`tg:ad:${alert.chain_id}:${alert.target_address}`}],...alertNavigationRows()]},
        });
        await store.recordDelivery(alert.id, event.eventKey, now);
        delivered += 1;
      }
      await store.updateBaseline({ id: alert.id, baseline: current, now });
      checked += 1;
    } catch (error) {
      failed += 1;
      console.error('[hookline-alerts] check failed', {
        alertId: alert.id,
        chainId: alert.chain_id,
        message: error instanceof Error ? error.message : String(error),
      });
      await store.reschedule({
        id: alert.id,
        now,
        nextCheckAt: now + ALERT_CHECK_INTERVAL_MS,
      });
    }
  }

  return { status: 'ok', due: due.length, checked, seeded, delivered, failed };
}
