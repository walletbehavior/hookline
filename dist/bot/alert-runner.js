'use strict';

import { TelegramClient } from './bot-api.js';
import { CHAIN_CONFIG } from './chains.js';
import { resolveHookMarkets as fallbackResolver } from './market.js';
import {
  ALERT_CHECK_INTERVAL_MS,
  AlertStorageUnavailableError,
  makeD1AlertStore,
} from './alerts-store.js';

export const SCAN_CAP_PER_RUN = 25;
export const SCAN_CAP_PER_USER = 10;
export const LIQUIDITY_CHANGE_THRESHOLD = 0.10;

function marketBaseline(result) {
  const markets = Array.isArray(result?.markets) ? result.markets : [];
  const poolIds = [...new Set(markets
    .map((market) => String(market?.pairAddress || market?.poolId || '').toLowerCase())
    .filter(Boolean))].sort();
  const aggregateLiquidityUsd = markets.reduce((sum, market) => {
    const liquidity = Number(market?.liquidityUsd);
    return sum + (Number.isFinite(liquidity) && liquidity > 0 ? liquidity : 0);
  }, 0);
  return { poolIds, aggregateLiquidityUsd };
}

function parseBaseline(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed?.poolIds)) return null;
    return {
      poolIds: parsed.poolIds.map((item) => String(item).toLowerCase()).sort(),
      aggregateLiquidityUsd: Number(parsed.aggregateLiquidityUsd) || 0,
    };
  } catch {
    return null;
  }
}

function shortAddress(value) {
  const address = String(value || '');
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
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
  if (newPools.length) {
    events.push({
      kind: 'new_pool',
      count: newPools.length,
      eventKey: `new_pool:${stableHash(newPools.join(','))}`,
    });
  }
  if (previous.aggregateLiquidityUsd > 0) {
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

function formatNotification(alert, event, previous, current) {
  const chainName = CHAIN_CONFIG[Number(alert.chain_id)]?.name || `Chain ${alert.chain_id}`;
  const change = event.kind === 'new_pool'
    ? `${event.count} new pool${event.count === 1 ? '' : 's'} detected`
    : `Liquidity ${event.ratio >= 0 ? 'rose' : 'fell'} ${Math.abs(event.ratio * 100).toFixed(1)}%`;
  return [
    'Hookline alert',
    `${chainName}, ${shortAddress(alert.target_address)}`,
    change,
    `Liquidity: ${money(previous.aggregateLiquidityUsd)}, ${money(current.aggregateLiquidityUsd)}`,
    `https://hookline.world/#/board/${alert.chain_id}/${alert.target_address}`,
  ].join('\n');
}

async function defaultSend(env, chatId, text) {
  if (!env?.TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot token is unavailable');
  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  return client.sendMessage(chatId, text, { disable_web_page_preview: true });
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
  const sendMessage = options.sendMessage || ((chatId, text) => defaultSend(env, chatId, text));
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
      const result = await resolveHookMarkets(Number(alert.chain_id), String(alert.target_address));
      const previous = parseBaseline(alert.baseline_json);
      const current = marketBaseline(result);
      if (!previous) {
        await store.updateBaseline({ id: alert.id, baseline: current, now });
        seeded += 1;
        checked += 1;
        continue;
      }

      for (const event of alertEvents(previous, current)) {
        if (await store.hasDelivery(alert.id, event.eventKey)) continue;
        await sendMessage(String(alert.chat_id), formatNotification(alert, event, previous, current));
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
