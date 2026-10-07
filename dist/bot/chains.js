// ----------------------------------------------------------------------------
// bot/chains.js — Chain configuration
//
// Reuses the Hookline Cloudflare Worker's chain configuration (worker/index.js
// CHAIN_CONFIG), derived from the RavenOS chain-profile model
// (lib/customer_trade/evm_chain_profiles.mjs): chainId -> {
//   chainId, chainIdHex, code, name, rpc, transaction_submission_supported }
// mapping.
//
// The bot never calls a remote RavenOS quote router: chain identity and RPC
// endpoints are local constants, identical to the worker serving hookline.world.
//
// Extraction provenance:
//   - worker/index.js : CHAIN_CONFIG, SUPPORTED_CHAINS, DEXSCREENER_CHAIN_SLUGS
//   - lib/customer_trade/evm_chain_profiles.mjs: evmChainProfile shape
// ----------------------------------------------------------------------------
'use strict';

const RAW_CHAIN_CONFIG = {
  1: { name: 'Ethereum', code: 'ETH', upstream: 'https://eth.drpc.org' },
  8453: { name: 'Base', code: 'BASE', upstream: 'https://base-rpc.publicnode.com' },
  42161: { name: 'Arbitrum One', code: 'ARB', upstream: 'https://arb1.arbitrum.io/rpc' },
  4663: { name: 'Robinhood Chain', code: 'RHB', upstream: 'https://robinhood.drpc.org' },
};

export const CHAIN_CONFIG = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_CHAIN_CONFIG).map(([idKey, cfg]) => [
      Number(idKey),
      Object.freeze({
        chainId: Number(idKey),
        chainIdHex: '0x' + Number(idKey).toString(16),
        name: cfg.name,
        code: cfg.code,
        rpc: cfg.upstream,
        transaction_submission_supported: false,
      }),
    ])
  )
);

export const SUPPORTED_CHAINS = Object.freeze(
  [...Object.keys(CHAIN_CONFIG)].map((k) => Number(k))
);

export const DEXSCREENER_CHAIN_SLUGS = Object.freeze({
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  146: 'sonic',
  480: 'worldchain',
  1868: 'soneium',
  4663: 'robinhood',
  8453: 'base',
  42161: 'arbitrum',
  42220: 'celo',
  43114: 'avalanche',
  57073: 'ink',
  81457: 'blast',
});

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function getChain(chainId) {
  const id = Number(chainId);
  return CHAIN_CONFIG[id] || null;
}

export function supportsChain(chainId) {
  return SUPPORTED_CHAINS.includes(Number(chainId));
}

export function renderChainInfo(chainId) {
  const chain = getChain(chainId);
  if (!chain) return null;
  return `${chain.name} (${chain.code}) • chainId ${chainId} (${chain.chainIdHex})`;
}
