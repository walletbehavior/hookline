// ----------------------------------------------------------------------------
// bot/token-view.js — Compact token card and inline navigation
//
// Renders a compact token card for Telegram with deterministic inline buttons
// for Hook | Related tokens | DexScreener | Buy presets | Sell presets |
// Refresh | Back.
// ----------------------------------------------------------------------------
'use strict';

import { getChain } from './chains.js';
import { KEYS, buyPresets, sellPresets } from './keys.js';

const MAX_MARKETS = 4;

export function formatMoneyUsd(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value >= 1 ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${value.toFixed(6)}`;
}

/** Build the compact token card message + inline keyboard. */
export function renderTokenCard(token, chainId, hookInfo, markets) {
  const chain = getChain(chainId);
  const marketsShown = markets.slice(0, MAX_MARKETS);
  const hasMarkets = marketsShown.length > 0;
  const totalLiquidity = markets.reduce((sum, m) => sum + (m.liquidityUsd || 0), 0);
  const totalVolume = markets.reduce((sum, m) => sum + (m.volumeUsd || 0), 0);

  let hookLine = 'Hook: none indexed';
  let hookButton = null;
  if (hookInfo) {
    hookLine = `Hook: ${hookInfo.hookName || 'v4 hook'} • ${hookInfo.hookAddress.slice(2, 10)}...${hookInfo.hookAddress.slice(-6)}`;
    hookButton = KEYS.hook(chainId, hookInfo.hookAddress);
  }

  let marketsLine = hasMarkets
    ? `Markets: ${marketsShown.length} pool${marketsShown.length === 1 ? '' : 's'} • $${formatMoneyUsd(totalLiquidity).slice(1)} TVL`
    : 'Markets: none found';

  let priceLine = '';
  if (hasMarkets && marketsShown[0].priceUsd != null) {
    priceLine = `Price (est.): ${formatMoneyUsd(marketsShown[0].priceUsd)} • h24 ${marketsShown[0].priceChangeH24 != null ? `${marketsShown[0].priceChangeH24 > 0 ? '+' : ''}${marketsShown[0].priceChangeH24.toFixed(2)}%` : 'n/a'}`;
  }

  const lines = [
    `🪝 *Hookline* • *Token*`,
    ``,
    `*${token.symbol}* ${token.name ? `(${token.name})` : ''}`,
    ``,
    `${chain ? `Chain: ${chain.name} (${chain.code}) • ${chainId}` : `Chain: ${chainId}`}`,
    `Address: \`${token.address}\``,
    hookLine,
    priceLine,
    marketsLine,
    ``,
    'Trade preview available. No transaction is submitted.',
  ].filter(Boolean);

  const inlineKeyboard = [
    [hookButton ?? KEYS.related(chainId, hookInfo?.hookAddress || token.address), KEYS.refresh(chainId, token.address)],
  ];
  if (hasMarkets) {
    inlineKeyboard.push([KEYS.dex(chainId, token.address)]);
  } else {
    inlineKeyboard.push([KEYS.dex(chainId, token.address)]);
  }
  inlineKeyboard.push([KEYS.related(chainId, hookInfo?.hookAddress || token.address)]);
  inlineKeyboard.push([
    { text: 'Buy preview', callback_data: `tg:buy:${chainId}:${token.address}` },
    { text: 'Sell preview', callback_data: `tg:sell:${chainId}:${token.address}` },
  ]);
  inlineKeyboard.push([KEYS.back()]);

  return {
    text: lines.join('\n'),
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: inlineKeyboard },
    token,
    chainId: Number(chainId),
    hookInfo,
    markets: markets.slice(0, 8),
  };
}

/** Build the "preset grid" message (reply) for buy/sell presets. */
export function renderPresetGrid(chainId, token, side) {
  const buttons = side === 'buy' ? buyPresets(chainId, token.address) : sellPresets(chainId, token.address);
  return {
    text: `💰 *${side === 'buy' ? 'Buy' : 'Sell'} preset* ${token.symbol} (${token.address.slice(2, 10)}...)`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [buttons, [KEYS.back()]],
    },
  };
}
