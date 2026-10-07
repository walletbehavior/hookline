// ----------------------------------------------------------------------------
// bot/fees.js — Fee collection and user cashback math
//
// Extracted from RavenOS lib/customer_product.mjs:
//
//   RAVEN_STANDARD_EXECUTION_FEE_BPS = 100            // 1.00% execution fee
//   RAVEN_PRO_EXECUTION_FEE_BPS = 100                 // 1.00% execution fee
//   RAVEN_PRO_CASHBACK_PERCENT = 30                   // 30% of Raven fee
//   RAVEN_CASHBACK_BASIS  = "confirmed_customer_raven_fee_before_provider_share"
//
// Because the cashback is 30% of the 1% Raven fee, the user cashback equals
// 0.30% of the trade notional — the documented "1% fee, 0.3% cashback".
// ----------------------------------------------------------------------------
'use strict';

export const RAVEN_STANDARD_EXECUTION_FEE_BPS = 100;
export const RAVEN_PRO_EXECUTION_FEE_BPS = 100;
export const RAVEN_PRO_CASHBACK_PERCENT = 30;
export const USDC_SCALE = 1_000_000n;
export const MAX_MONEY_MICROS = 9_007_199_254_740_991n;
export const CASHBACK_BASIS = 'confirmed_customer_raven_fee_before_provider_share';

export function feeRate() {
  return RAVEN_STANDARD_EXECUTION_FEE_BPS / 10000;
}

export function cashbackRate() {
  return (RAVEN_STANDARD_EXECUTION_FEE_BPS / 10000) * (RAVEN_PRO_CASHBACK_PERCENT / 100);
}

export function bpsToRate(bps) {
  return bps / 10000;
}

export function microsToUsdc(micros) {
  const n = Number(micros);
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

export function feeMicros(usdcNotional) {
  const usdc = Math.round(Number(usdcNotional) * Number(USDC_SCALE));
  if (!Number.isSafeInteger(usdc) || usdc < 0) throw new Error('money_out_of_range');
  const feeMicros = (BigInt(usdc) * BigInt(RAVEN_STANDARD_EXECUTION_FEE_BPS)) / 10000n;
  return feeMicros.toString();
}

export function cashbackMicros(feeMicros) {
  const fee = BigInt(String(feeMicros));
  return (fee * BigInt(RAVEN_PRO_CASHBACK_PERCENT) / 100n).toString();
}

export function moneyMicros(value) {
  if (typeof value !== 'string' && typeof value !== 'bigint')
    throw new Error('money_requires_integer_string');
  if (!/^\d{1,16}$/.test(String(value))) throw new Error('money_invalid');
  const amount = BigInt(value);
  if (amount > MAX_MONEY_MICROS) throw new Error('money_out_of_range');
  return amount;
}
