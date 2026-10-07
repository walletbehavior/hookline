// ----------------------------------------------------------------------------
// bot/keys.js — Telegram inline keyboard layouts
//
// Deterministic callback navigation between token, hook, and sibling token
// views. All callback_data values are lowercase and follow the format
// tg:{action}:{chainId}:{param1}[:{param2}] so navigation is reproducible and
// order-independent.
//
// Required inline buttons: Hook | Related tokens | DexScreener | Buy presets |
// Sell presets | Refresh | Back
// ----------------------------------------------------------------------------
'use strict';

const TG = 'tg';
const PRESETS_USD = [10, 100, 1000, 10000];

function fmtNotional(notional) {
  return Number(notional).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function dexUrlFor(chainId, tokenAddress) {
  if (!tokenAddress) {
    return 'https://dexscreener.com/search?search=';
  }
  const slug = CHAIN_SLUGS[Number(chainId)];
  if (slug) {
    return `https://dexscreener.com/${slug}/token/${tokenAddress.toLowerCase()}`;
  }
  return 'https://dexscreener.com/search?search=';
}

const CHAIN_SLUGS = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  4663: 'robinhood',
};

export const KEYS = Object.freeze({
  hook: (chainId, hookAddress) => ({
    text: '🪝 Hook',
    callback_data: `${TG}:hook:${chainId}:${hookAddress.toLowerCase()}`,
  }),
  related: (chainId, hookAddress) => ({
    text: '🔗 Related tokens',
    callback_data: `${TG}:siblings:${chainId}:${hookAddress.toLowerCase()}:0`,
  }),
  dex: (chainId, tokenAddress) => ({
    text: '📈 DexScreener',
    url: dexUrlFor(chainId, tokenAddress),
  }),
  refresh: (chainId, address) => ({
    text: '🔄 Refresh',
    callback_data: `${TG}:refresh:${chainId}:${address.toLowerCase()}`,
  }),
  back: () => ({
    text: 'Main menu',
    callback_data: `${TG}:menu:main`,
  }),
  sibling: (chainId, tokenAddress, label = '') => ({
    text: label ? String(label).slice(0, 18) : tokenAddress.slice(2, 10),
    callback_data: `${TG}:sibling:${chainId}:${tokenAddress.toLowerCase()}`,
  }),
  preset: (chainId, address, notional) => ({
    text: `$${fmtNotional(notional)}`,
    callback_data: `${TG}:bp:${chainId}:${address.toLowerCase()}:${notional}`,
  }),
  presetSell: (chainId, address, notional) => ({
    text: `$${fmtNotional(notional)}`,
    callback_data: `${TG}:sp:${chainId}:${address.toLowerCase()}:${notional}`,
  }),
  siblingPrev: (chainId, hookAddress, offset) => ({
    text: '◀',
    callback_data: `${TG}:siblings:${chainId}:${hookAddress.toLowerCase()}:${offset - 8}`,
  }),
  siblingNext: (chainId, hookAddress, offset) => ({
    text: '▶',
    callback_data: `${TG}:siblings:${chainId}:${hookAddress.toLowerCase()}:${offset + 8}`,
  }),
});

export function buyPresets(chainId, address) {
  return PRESETS_USD.map((n) => KEYS.preset(chainId, address, n));
}

export function sellPresets(chainId, address) {
  return PRESETS_USD.map((n) => KEYS.presetSell(chainId, address, n));
}
