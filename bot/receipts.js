// ----------------------------------------------------------------------------
// bot/receipts.js — Transaction receipt construction
//
// Reuses the RavenOS execution-receipt record schema (lib/agentic_trading/records.mjs):
//   - AgenticTradingSchemas.execution_receipt = "execution_receipt"
//   - RECEIPT_STATUSES: previewed, paper_submitted, partially_filled,
//     filled, rejected, expired, failed, ambiguous
//   - FORBIDDEN_SECRET_KEY_RE — never carry private keys / seed phrases /
//     raw transactions into records.
//
// The bot issues "previewed" receipts for simulated trades. A previewed
// receipt never contains a tx_hash, a private key, or any broadcast payload.
// Live receipts (when the execution gate is open) are built by importing the
// same schema from lib/agentic_trading/records.mjs in the worker — the bot
// reuses the shape directly.
//
// Extraction provenance:
//   - lib/agentic_trading/records.mjs : RECEIPT_STATUSES, AgenticTradingSchemas,
//     FORBIDDEN_SECRET_KEY_RE, FORBIDDEN_EXECUTION_PAYLOAD_KEY_RE
//   - lib/agentic_trading/identity.mjs: normalizedChainIdentity shape
// ----------------------------------------------------------------------------
'use strict';

import { normalizeTokenIdentity } from './wallets.js';

export const EXECUTION_RECEIPT_SCHEMA = 'ravenos.execution_receipt.v1';
export const AgenticTradingSchemas = Object.freeze({ execution_receipt: 'execution_receipt' });

export const RECEIPT_STATUSES = Object.freeze([
  'previewed',
  'paper_submitted',
  'partially_filled',
  'filled',
  'rejected',
  'expired',
  'failed',
  'ambiguous',
]);

export const FORBIDDEN_SECRET_KEY_RE =
  /(?:^|_)(?:private_?key|secret_?key|seed_?phrase|mnemonic|signing_?secret|api_?key|credential)(?:$|_)/i;
export const FORBIDDEN_EXECUTION_PAYLOAD_KEY_RE =
  /(?:^|_)(?:signed_?payload|signed_?transaction|raw_?transaction|serialized_?transaction|wallet_?signature|user_?signature|calldata|call_?data|destination_?address|recipient_?address|to_?address|broadcast_?payload|transaction_?payload|signer)(?:$|_)/i;

export function sanitizeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.slice(0, 240);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEY_RE.test(k) || FORBIDDEN_EXECUTION_PAYLOAD_KEY_RE.test(k)) continue;
    out[k] = sanitizeValue(v, seen);
  }
  return out;
}

export function buildPreviewReceipt(chainId, quote, readiness) {
  const feeMicros = quote.feeUsdcMicros;
  const cashbackMicros = quote.cashbackUsdcMicros;
  return {
    schema_version: EXECUTION_RECEIPT_SCHEMA,
    receipt_id: receiptIdFor(chainId, quote, 'preview'),
    created_at: quote.previewedAt || new Date().toISOString(),
    chain_id: Number(chainId),
    chain_code: '',
    tx_hash: null,
    block_number: null,
    status: 'previewed',
    side: quote.side,
    input_token: quote.inputToken,
    output_token: quote.outputToken,
    input_amount_usd: quote.inputAmountUsd,
    price_usd: quote.priceUsd,
    slippage_bps: quote.slippageBps,
    fee_bps: quote.feeBps,
    fee_usdc_micros: String(feeMicros),
    fee_usdc: quote.feeUsdc,
    cashback_usdc_micros: String(cashbackMicros),
    cashback_usdc: quote.cashbackUsdc,
    cashback_basis: 'confirmed_customer_raven_fee_before_provider_share',
    provider_share_usdc_micros: String(feeMicros - cashbackMicros),
    min_received_usd: quote.minReceivedUsd,
    sim_only: true,
    not_executed: true,
    not_executed_reason: readiness.reason || 'execution gate closed',
    evidence: {
      source: 'telegram_bot',
      preview: true,
      note: 'Simulated preview; no transaction submitted.',
    },
  };
}

function receiptIdFor(chainId, quote, prefix) {
  const payload = JSON.stringify({
    chainId,
    side: quote.side,
    notional: quote.inputAmountUsd,
    token: quote.inputToken?.address || '',
    previewedAt: quote.previewedAt || '',
  });
  return `${prefix}_${Number(chainId)}_${stableHash(payload)}`;
}

function stableHash(data) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(data)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
