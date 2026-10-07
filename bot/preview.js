// ----------------------------------------------------------------------------
// bot/preview.js: deterministic trade preview
//
// The bot never executes a trade by default. buildSimulatedPreview produces a
// deterministic preview of what a trade would cost: 1% Hookline gross fee and
// 0.3% instant cashback computed from shared constants (bot/fees.js), plus an
// estimated minimum received value after slippage.
//
// Live execution is ONLY enabled when bot/exec-config.js reports ready:
// EXECUTION_ENABLED === "1" AND RUN_EXECUTION_SECRET present (>= 16 chars).
// Otherwise the preview is marked "not_executed" with the gate reason, and a
// receipt is issued with status "previewed" only.
//
// SECURITY: no seed phrase, private key, raw transaction, or broadcast payload
// is ever created, requested, or logged. Preview receipts contain no tx_hash.
// ----------------------------------------------------------------------------
'use strict';

import { executionReadiness } from './exec-config.js';
import { buildSimulatedQuote } from './quote.js';
import { buildPreviewReceipt } from './receipts.js';
import { formatMoneyUsd } from './token-view.js';
import { formatAddress } from './wallets.js';

const DEFAULT_NOTIONAL_USD = 100;
const DEFAULT_SLIPPAGE_BPS = 50;

export function canExecute(readiness) {
  return readiness.ready;
}

/** Build a preview of a simulated buy/sell trade. */
export function buildSimulatedPreview({ side, notionalUsd = DEFAULT_NOTIONAL_USD, chainId, inputToken, slippageBps = DEFAULT_SLIPPAGE_BPS, priceUsd = null }) {
  if (notionalUsd <= 0) throw new Error('notional must be positive');
  const quote = buildSimulatedQuote({ chainId, side, inputToken, notionalUsd, slippageBps, priceUsd });
  return quote;
}

/** Render the preview message and, when gated, the execution-receipt shape. */
export function renderTradePreview(chainId, side, notionalUsd, inputToken, readiness) {
  const quote = buildSimulatedPreview({ side, notionalUsd, chainId, inputToken });
  const receipt = buildPreviewReceipt(chainId, quote, readiness);
  const priceLine = quote.priceUsd
    ? `Rate: ~${quote.priceUsd} ${inputToken.symbol}/USDC (estimated; not a quote)`
    : 'Rate: n/a (pool data unavailable; estimate only)';

  const lines = [
    `⚡ *${side === 'buy' ? 'Buy' : 'Sell'} preview, ${inputToken.symbol || 'token'}*`,
    ``,
    `Chain: ${chainId}`,
    `Notional: $${notionalUsd.toLocaleString('en-US')} (${side === 'buy' ? 'USDC in' : `${inputToken.symbol} out`})`,
    priceLine,
    `Slippage: ${quote.slippageBps} bps`,
    ``,
    `Gross fee (1%): $${quote.feeUsdc.toFixed(4)}`,
    `Instant cashback (0.3%): $${quote.cashbackUsdc.toFixed(6)}`,
    `Effective fee (0.7%): $${(quote.feeUsdc - quote.cashbackUsdc).toFixed(6)}`,
    `Min received: $${quote.minReceivedUsd.toFixed(4)}`,
    ``,
  ];

  if (readiness.ready) {
    lines.push(`Status: LIVE (execution enabled by runtime secrets)`);
  } else {
    lines.push(`Status: PREVIEW`, `Not executed, ${readiness.reason}`, `Receipt: ${receipt.receipt_id.slice(0, 24)}...`);
  }

  return {
    message: {
      text: lines.join('\n'),
      parse_mode: 'Markdown',
    },
    quote,
    receipt,
  };
}
