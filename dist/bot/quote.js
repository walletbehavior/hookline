// ----------------------------------------------------------------------------
// bot/quote.js — Quote construction
//
// Mirrors the RavenOS trading-terminal quote payload shape
// (lib/agentic_trading/routes.mjs /api/trade/quote request body and the
// terminal's requestQuote / renderQuote flow in ravenos-terminal-trade.js).
//
// Quote request payload (RavenOS ravenos-terminal-trade.js):
//   client_request_id, chain, input_asset, output_asset,
//   exact_input_amount_base_units, display_amount, asset_decimals,
//   slippage_bps, wallet_capability_context
//
// The bot uses this shape to build a quote request for the RavenOS backend,
// and for simulated previews it computes fee/cashback locally (bot/fees.js)
// from the same RAVEN_STANDARD_EXECUTION_FEE_BPS / RAVEN_PRO_CASHBACK_PERCENT
// constants. The bot never executes a trade unless the execution gate is open.
//
// Extraction provenance:
//   - lib/agentic_trading/routes.mjs      : /api/trade/quote request schema
//   - ravenos-terminal-trade.js           : requestQuote payload building
//   - lib/customer_product.mjs            : RAVEN_STANDARD_EXECUTION_FEE_BPS
//   - lib/customer_rewards.mjs            : captureExecutionRewards fee receipt
// ----------------------------------------------------------------------------
'use strict';

import { RAVEN_STANDARD_EXECUTION_FEE_BPS, cashbackRate } from './fees.js';
import { EVM_ADDRESS_RE, normalizeTokenIdentity } from './wallets.js';

export function parseDisplayToBaseUnits(displayAmount, decimals) {
  const raw = String(displayAmount ?? '').trim();
  const precision = Number(decimals);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isInteger(precision) || precision < 0 || precision > 36) {
    throw new Error('invalid amount');
  }
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > precision) throw new Error('amount has too many decimals');
  const units = BigInt(whole) * (10n ** BigInt(precision))
    + BigInt((fraction + '0'.repeat(precision)).slice(0, precision) || '0');
  if (units <= 0n) throw new Error('invalid amount');
  return units.toString();
}

export function buildQuotePayload({ chainId, inputToken, outputToken, displayAmount, slippageBps = 50, walletCapabilityContext = null }) {
  const exactInputAmountBaseUnits = parseDisplayToBaseUnits(displayAmount, inputToken.decimals || 18);
  return {
    client_request_id: `tg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chain: String(chainId),
    input_asset: {
      type: 'erc20',
      address: inputToken.address.toLowerCase(),
      symbol: inputToken.symbol || '',
      decimals: Number(inputToken.decimals) || 18,
      name: inputToken.name || '',
    },
    output_asset: {
      type: 'erc20',
      address: outputToken.address.toLowerCase(),
      symbol: outputToken.symbol || '',
      decimals: Number(outputToken.decimals) || 18,
      name: outputToken.name || '',
    },
    exact_input_amount_base_units: exactInputAmountBaseUnits,
    display_amount: displayAmount,
    asset_decimals: Number(inputToken.decimals) || 18,
    slippage_bps: Number(slippageBps) || 50,
    wallet_capability_context: walletCapabilityContext,
  };
}

export function assetFromIdentity(identity) {
  const norm = normalizeTokenIdentity(identity);
  if (!norm) throw new Error('invalid token identity');
  return {
    type: 'erc20',
    address: norm.address,
    symbol: norm.symbol || 'TOKEN',
    decimals: 18,
    name: norm.name || 'Token',
  };
}

export function buildSimulatedQuote({ chainId, side, inputToken, notionalUsd, slippageBps = 50, priceUsd = null }) {
  const feeBps = RAVEN_STANDARD_EXECUTION_FEE_BPS;
  const feeMicros = computeFeeMicros(notionalUsd, feeBps);
  const cashbackMicros = computeCashbackMicros(feeMicros);
  const feeUsdc = feeMicros / 1_000_000;
  const cashbackUsdc = cashbackMicros / 1_000_000;

  const priceRate = priceUsd || 1;
  const slippageRate = slippageBps / 10000;
  const minReceivedUsd = side === 'buy'
    ? notionalUsd * priceRate * (1 - slippageRate)
    : notionalUsd * (1 - slippageRate);

  return {
    chainId: Number(chainId),
    side,
    inputAmountUsd: notionalUsd,
    inputToken: normalizeTokenIdentity(inputToken),
    outputToken: null,
    priceUsd: priceUsd,
    priceImpactBps: null,
    slippageBps,
    feeBps,
    feeUsdcMicros: feeMicros,
    feeUsdc: feeUsdc,
    cashbackUsdcMicros: cashbackMicros,
    cashbackUsdc: cashbackUsdc,
    cashbackRate: cashbackRate(),
    minReceivedUsd,
    simOnly: true,
    notExecuted: true,
    previewedAt: new Date().toISOString(),
  };
}

function computeFeeMicros(usdcNotional, feeBps) {
  const usdc = Math.round(usdcNotional * 1_000_000);
  return Math.round((usdc * feeBps) / 10000);
}

function computeCashbackMicros(feeMicros) {
  return Math.round(feeMicros * 0.3);
}
