// ----------------------------------------------------------------------------
// bot/wallets.js — Wallet handling
//
// Reuses RavenOS public-address wallet concepts:
//   - lib/customer_wallet_balances.mjs : public-address-only reads; balance
//     scope 'chain_local_balances_before_network_fees'; execution_authority:false
//   - lib/customer_trade/evm_chain_profiles.mjs : EVM address normalization
//
// The bot only displays chain balances and contract identities. It never
// obtains spending authority, never requests a seed phrase or private key, and
// never logs key material.
// ----------------------------------------------------------------------------
'use strict';

import { SUPPORTED_CHAINS } from './chains.js';

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ZERO_ADDRESS = '0x' + '0'.repeat(40);

export function validateEvmAddress(value) {
  const addr = String(value || '').trim().toLowerCase();
  return EVM_ADDRESS_RE.test(addr) && addr !== EVM_ZERO_ADDRESS ? addr : null;
}

export function formatAddress(value, chars = 4) {
  const addr = validateEvmAddress(value);
  if (!addr) return String(value ?? '');
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
}

export function parseAddress(value, chainId) {
  const id = Number(chainId);
  if (!SUPPORTED_CHAINS.includes(id)) return null;
  const addr = validateEvmAddress(value);
  return addr ? { chainId: id, type: 'evm', address: addr } : null;
}

export function normalizeTokenIdentity(token) {
  const address = validateEvmAddress(token?.address) || null;
  const name = typeof token?.name === 'string' ? token.name.slice(0, 100) : null;
  const symbol = typeof token?.symbol === 'string' ? token.symbol.slice(0, 24) : null;
  return address || name || symbol
    ? { address, name, symbol }
    : null;
}
