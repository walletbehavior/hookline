/**
 * execution-rail.js — Reusable intent, economics, and lifecycle model for
 * caller-owned EVM wallets.
 *
 * This module only models validated trade intent, fee economics, and state
 * lifecycle for a wallet/provider the caller already owns and controls. It does
 * not create keys or seeds, read cookies or secrets from the environment, talk
 * to any network endpoint, inspect the browser, or submit or sign
 * transactions. It is a pure browser ES module with no dependencies.
 *
 * Supported chains: Ethereum (1), BNB (56), Robinhood (4663), Base (8453).
 */
'use strict';

// ----------------------------------------------------------------------------
// Fee constants
// ----------------------------------------------------------------------------
// Execution fee: 100 bps (1.00%) of the trade notional.
export const EXECUTION_FEE_BPS = 100;
// Notional cashback: 30 bps (0.30%) of the trade notional.
export const NOTIONAL_CASHBACK_BPS = 30;
// Slippage window: 1 bps (0.01%) minimum, 5000 bps (50.00%) maximum.
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5000;
// Maximum decimal fraction digits accepted for display amounts (36 is a safe
// ceiling that still exceeds any realistic token precision).
export const MAX_DISPLAY_FRACTION_DIGITS = 36;
// Oversized amount boundary in base units. Any trade leg above this value is
// rejected as implausible. At 18 decimals this equals 1e12 of display units.
export const MAX_AMOUNT_BASE_UNITS = 10n ** 30n;

// ----------------------------------------------------------------------------
// Chain identity (generic; not tied to any specific platform).
// ----------------------------------------------------------------------------
const CHAIN_REGISTRY = Object.freeze({
  1: { chainId: 1, name: 'Ethereum', code: 'ETH', chainIdHex: '0x1' },
  56: { chainId: 56, name: 'BNB', code: 'BNB', chainIdHex: '0x38' },
  4663: { chainId: 4663, name: 'Robinhood', code: 'RHB', chainIdHex: '0x1227' },
  8453: { chainId: 8453, name: 'Base', code: 'BASE', chainIdHex: '0x2105' },
});

export const SUPPORTED_CHAIN_IDS = Object.freeze(
  [...Object.keys(CHAIN_REGISTRY)].map((key) => Number(key))
);

// ----------------------------------------------------------------------------
// Value validators (pure; never touch the environment).
// ----------------------------------------------------------------------------

/**
 * Validates and normalizes an EVM address. Rejects malformed strings,
 * addresses with non-hex characters, wrong length, and the all-zeros address.
 * Uppercase input is accepted and normalized to lowercase.
 */
export function validateEvmAddress(value) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error('invalid_evm_address');
  }
  const addr = raw.toLowerCase();
  const isZero = /^0x0{40}$/.test(addr);
  if (isZero) {
    throw new Error('address_is_zero');
  }
  return addr;
}

function normalizeChainId(chainId) {
  const id = Number(chainId);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    throw new Error('invalid_chain_id');
  }
  const key = String(id);
  if (!(key in CHAIN_REGISTRY)) {
    throw new Error('chain_not_supported');
  }
  return CHAIN_REGISTRY[key];
}

function normalizeBps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_SLIPPAGE_BPS || n > MAX_SLIPPAGE_BPS) {
    throw new Error('bps_out_of_range');
  }
  return n;
}

function normalizeDecimal(value) {
  const d = Number(value);
  if (!Number.isFinite(d) || !Number.isInteger(d) || d < 0 || d > MAX_DISPLAY_FRACTION_DIGITS) {
    throw new Error('invalid_decimals');
  }
  return d;
}

function normalizeAmount(value) {
  const str = String(value).trim();
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new Error('amount_requires_string_or_bigint');
  }
  if (!/^\d+$/.test(str)) {
    throw new Error('amount_must_be_numeric_string');
  }
  const amount = BigInt(str);
  if (amount <= 0n) {
    throw new Error('amount_not_positive');
  }
  if (amount > MAX_AMOUNT_BASE_UNITS) {
    throw new Error('amount_oversized');
  }
  return amount;
}

function normalizeToken(token) {
  if (!token || typeof token !== 'object') {
    throw new Error('token_object_required');
  }
  const address = validateEvmAddress(token.address);
  const decimals = normalizeDecimal(token.decimals);
  const name = typeof token.name === 'string' ? token.name.slice(0, 64) : null;
  const symbol = typeof token.symbol === 'string' ? token.symbol.slice(0, 24) : null;
  return { address, decimals, name, symbol };
}


// ----------------------------------------------------------------------------
// Decimal <-> base-unit conversion.
// ----------------------------------------------------------------------------

/**
 * Converts a human-readable display amount (e.g. "1.5") into base units for a
 * token with the given decimals. The conversion is exact: the result is a
 * decimal string of integer base units.
 *
 * Rejects missing/empty input, non-numeric input, fraction digits that exceed
 * the token's declared precision, amounts of exactly zero, and amounts above
 * the bounded size limit.
 */
export function parseDisplayToBaseUnits(displayAmount, decimals) {
  const raw = String(displayAmount ?? '').trim();
  if (raw === '' || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('invalid_display_amount');
  }
  const precision = normalizeDecimal(decimals);
  const [wholePart, fractionPart = ''] = raw.split('.');
  const trimmed = fractionPart.slice(0, precision);
  if (trimmed.length < fractionPart.length) {
    throw new Error('amount_exceeds_token_precision');
  }
  const units = BigInt(wholePart) * 10n ** BigInt(precision) + (trimmed ? BigInt(trimmed + '0'.repeat(precision - trimmed.length)) : 0n);
  if (units <= 0n) {
    throw new Error('amount_not_positive');
  }
  if (units > MAX_AMOUNT_BASE_UNITS) {
    throw new Error('amount_oversized');
  }
  return units.toString();
}

// ----------------------------------------------------------------------------
// Bounded fee-stack calculator.
// ----------------------------------------------------------------------------

/**
 * Computes the execution fee and cashback for a trade leg in base units.
 *
 * The execution fee is a configurable number of basis points of the notional
 * (default EXECUTION_FEE_BPS). The notional cashback is a configurable number
 * of basis points of the notional (default NOTIONAL_CASHBACK_BPS). Both are
 * computed with integer arithmetic: results are truncated toward zero, which is
 * the standard on-chain rounding behavior.
 *
 * The function is bounded: it guards that the fee never exceeds the notional
 * and that the net amount remains positive.
 */
export function buildFeeStack({
  amountBaseUnits,
  feeBps = EXECUTION_FEE_BPS,
  cashbackBps = NOTIONAL_CASHBACK_BPS,
}) {
  const amount = normalizeAmount(amountBaseUnits);
  const feeB = normalizeBps(feeBps);
  const cashbackB = normalizeBps(cashbackBps);

  const feeBaseUnits = (amount * BigInt(feeB)) / 10000n;
  if (feeBaseUnits > amount) {
    throw new Error('fee_exceeds_notional');
  }

  const cashbackBaseUnits = (amount * BigInt(cashbackB)) / 10000n;
  const netBaseUnits = amount - feeBaseUnits + cashbackBaseUnits;
  if (netBaseUnits <= 0n) {
    throw new Error('net_amount_non_positive');
  }

  const netBps = (netBaseUnits * 10000n) / amount;

  return Object.freeze({
    amountBaseUnits: amount.toString(),
    feeBps: feeB,
    feeRate: feeB / 10000,
    feeAmountBaseUnits: feeBaseUnits.toString(),
    cashbackBps: cashbackB,
    cashbackRate: cashbackB / 10000,
    cashbackAmountBaseUnits: cashbackBaseUnits.toString(),
    netBaseUnitsAfterFeeAndCashback: netBaseUnits.toString(),
    netRateBps: Number(netBps),
  });
}


// ----------------------------------------------------------------------------
// EVM exact-input quote-request builder.
// ----------------------------------------------------------------------------

/**
 * Builds a validated quote request for an EVM exact-input swap.
 *
 * The request describes validated intent only: which chain, whose wallet
 * address, which two assets, how much is being spent, and the slippage
 * tolerance. No signing, network, or wallet material is included or accessed.
 *
 * Rejects malformed addresses, same-token routes, unsupported chains, invalid
 * decimals, nonpositive or oversized amounts, and slippage outside 1-5000 bps.
 */
export function buildQuoteRequest({
  chainId,
  fromAddress,
  inputToken,
  outputToken,
  amount,
  slippageBps = 50,
  amountIsBaseUnits = false,
}) {
  const chain = normalizeChainId(chainId);
  const from = validateEvmAddress(fromAddress);
  const input = normalizeToken(inputToken);
  const output = normalizeToken(outputToken);
  if (input.address === output.address) {
    throw new Error('route_same_tokens');
  }
  const slippage = normalizeBps(slippageBps);

  const exactInputAmountBaseUnits = amountIsBaseUnits
    ? normalizeAmount(amount).toString()
    : parseDisplayToBaseUnits(amount, input.decimals);

  const stack = buildFeeStack({ amountBaseUnits: exactInputAmountBaseUnits });

  return Object.freeze({
    chainId: chain.chainId,
    chainIdHex: chain.chainIdHex,
    fromAddress: from,
    inputAsset: {
      type: 'erc20',
      address: input.address,
      symbol: input.symbol || '',
      decimals: input.decimals,
      name: input.name || '',
    },
    outputAsset: {
      type: 'erc20',
      address: output.address,
      symbol: output.symbol || '',
      decimals: output.decimals,
      name: output.name || '',
    },
    exactInputAmountBaseUnits: exactInputAmountBaseUnits,
    displayAmount: amountIsBaseUnits ? null : String(amount),
    assetDecimals: input.decimals,
    slippageBps: slippage,
    walletCapabilityContext: null,
    economics: {
      feeBps: stack.feeBps,
      feeAmountBaseUnits: stack.feeAmountBaseUnits,
      cashbackBps: stack.cashbackBps,
      cashbackAmountBaseUnits: stack.cashbackAmountBaseUnits,
      netAmountBaseUnitsAfterFees: stack.netBaseUnitsAfterFeeAndCashback,
      netRateBps: stack.netRateBps,
    },
  });
}


// ----------------------------------------------------------------------------
// Quote normalizer.
// ----------------------------------------------------------------------------

/**
 * Normalizes a raw incoming quote payload into a canonical internal shape.
 *
 * Raw quotes may carry numeric fields as strings (for example, base-unit
 * amounts expressed in smallest denominations or micros). This function parses
 * them into consistent base-unit integer strings and validates every field
 * against the same rules used by the request builder.
 */
export function normalizeQuote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('quote_object_required');
  }

  const chain = normalizeChainId(raw.chainId);

  function coerceBigInt(value) {
    const str = String(value).trim();
    if (str === '' || !/^\d+$/.test(str)) {
      throw new Error('amount_field_invalid');
    }
    const n = BigInt(str);
    if (n <= 0n) {
      throw new Error('amount_not_positive');
    }
    if (n > MAX_AMOUNT_BASE_UNITS) {
      throw new Error('amount_oversized');
    }
    return n;
  }

  const inputToken = normalizeToken(raw.inputToken);
  const outputToken = normalizeToken(raw.outputToken);

  const amount = coerceBigInt(raw.inputAmountBaseUnits ?? raw.inputAmount);
  const outputAmount =
    raw.outputAmountBaseUnits != null ? coerceBigInt(raw.outputAmountBaseUnits) : null;
  const minReceived =
    raw.minReceivedBaseUnits != null ? coerceBigInt(raw.minReceivedBaseUnits) : null;
  const feeAmount = raw.feeAmountBaseUnits != null ? coerceBigInt(raw.feeAmountBaseUnits) : null;
  const cashbackAmount =
    raw.cashbackAmountBaseUnits != null ? coerceBigInt(raw.cashbackAmountBaseUnits) : null;

  const feeBps = raw.feeBps != null ? normalizeBps(raw.feeBps) : null;
  const cashbackBps = raw.cashbackBps != null ? normalizeBps(raw.cashbackBps) : null;
  const slippageBps = raw.slippageBps != null ? normalizeBps(raw.slippageBps) : null;

  let quotedAt = null;
  if (typeof raw.quotedAt === 'string' && raw.quotedAt.trim() !== '') {
    const parsed = Date.parse(raw.quotedAt);
    if (Number.isFinite(parsed)) {
      quotedAt = new Date(parsed).toISOString();
    }
  }

  return Object.freeze({
    chainId: chain.chainId,
    chainIdHex: chain.chainIdHex,
    chainName: chain.name,
    fromAddress: validateEvmAddress(raw.fromAddress ?? null),
    inputToken: {
      address: inputToken.address,
      symbol: inputToken.symbol,
      decimals: inputToken.decimals,
      name: inputToken.name,
    },
    outputToken: {
      address: outputToken.address,
      symbol: outputToken.symbol,
      decimals: outputToken.decimals,
      name: outputToken.name,
    },
    inputAmountBaseUnits: amount.toString(),
    outputAmountBaseUnits: outputAmount ? outputAmount.toString() : null,
    minReceivedBaseUnits: minReceived ? minReceived.toString() : null,
    feeAmountBaseUnits: feeAmount ? feeAmount.toString() : null,
    cashbackAmountBaseUnits: cashbackAmount ? cashbackAmount.toString() : null,
    feeBps,
    cashbackBps,
    slippageBps,
    quotedAt,
  });
}


// ----------------------------------------------------------------------------
// Strict lifecycle reducer (generic; not tied to any specific platform).
// ----------------------------------------------------------------------------

export const RAIL_STATE_NAMES = Object.freeze({
  IDLE: 'idle',
  QUOTING: 'quoting',
  QUOTED: 'quoted',
  APPROVAL_REQUIRED: 'approval_required',
  SIGNING: 'signing',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
});

export const RAIL_EVENT_NAMES = Object.freeze({
  START_QUOTE: 'START_QUOTE',
  QUOTE_RECEIVED: 'QUOTE_RECEIVED',
  REQUEST_APPROVAL: 'REQUEST_APPROVAL',
  APPROVAL_SUBMITTED: 'APPROVAL_SUBMITTED',
  SIGNED: 'SIGNED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  ERROR: 'ERROR',
});

/**
 * Strict state-transition table for the execution lifecycle. Only transitions
 * explicitly listed in the table are allowed. Any other event is rejected with
 * an error that names the allowed events for the current state. An ERROR event
 * is the only transition permitted from every state.
 */
const STATE_TRANSITION_TABLE = Object.freeze({
  idle: { [RAIL_EVENT_NAMES.START_QUOTE]: 'quoting', [RAIL_EVENT_NAMES.ERROR]: 'failed' },
  quoting: { [RAIL_EVENT_NAMES.QUOTE_RECEIVED]: 'quoted', [RAIL_EVENT_NAMES.ERROR]: 'failed' },
  quoted: {
    [RAIL_EVENT_NAMES.REQUEST_APPROVAL]: 'approval_required',
    [RAIL_EVENT_NAMES.SIGNED]: 'submitted',
    [RAIL_EVENT_NAMES.ERROR]: 'failed',
  },
  approval_required: {
    [RAIL_EVENT_NAMES.APPROVAL_SUBMITTED]: 'signing',
    [RAIL_EVENT_NAMES.ERROR]: 'failed',
  },
  signing: { [RAIL_EVENT_NAMES.SIGNED]: 'submitted', [RAIL_EVENT_NAMES.ERROR]: 'failed' },
  submitted: { [RAIL_EVENT_NAMES.CONFIRMED]: 'confirmed', [RAIL_EVENT_NAMES.FAILED]: 'failed', [RAIL_EVENT_NAMES.ERROR]: 'failed' },
  confirmed: { [RAIL_EVENT_NAMES.ERROR]: 'failed' },
  failed: { [RAIL_EVENT_NAMES.ERROR]: 'failed' },
});

/**
 * Strict reducer. Given a current state and an event string, returns the next
 * state or throws. The throw message lists the events allowed from the given
 * state, which aids debugging of integration code.
 */
export function railReducer(state, action) {
  if (!Object.hasOwn(STATE_TRANSITION_TABLE, state)) {
    throw new Error(`unknown_initial_state: ${String(state)}`);
  }
  const allowed = STATE_TRANSITION_TABLE[state];
  if (!Object.hasOwn(allowed, action)) {
    const permitted = Object.keys(allowed).join(', ');
    throw new Error(
      `invalid_state_transition: ${String(state)} + ${String(action)}. ` +
        `permitted from this state: ${permitted}`
    );
  }
  return allowed[action];
}

/**
 * Test whether an event is allowed from the given state without mutating
 * anything.
 */
export function canTransition(state, action) {
  return Object.hasOwn(STATE_TRANSITION_TABLE, state) &&
    Object.hasOwn(STATE_TRANSITION_TABLE[state], action);
}

/**
 * Test whether the given state is terminal (no normal progression out).
 */
export function isTerminalState(state) {
  return state === 'confirmed' || state === 'failed';
}

/**
 * Builder for a stateful execution rail. The rail owns a single mutable state
 * value and exposes transition, inspection, and reset helpers. It does not hold
 * any keys, credentials, or network references.
 */
export function createExecutionRail() {
  let state = 'idle';

  return Object.freeze({
    getState() {
      return state;
    },
    transition(action) {
      state = railReducer(state, action);
      return state;
    },
    canTransition(action) {
      return canTransition(state, action);
    },
    isTerminal() {
      return isTerminalState(state);
    },
    reset() {
      state = 'idle';
      return state;
    },
  });
}
