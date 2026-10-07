import assert from 'node:assert/strict';
import test from 'node:test';

import * as rail from '../../dist/execution-rail.js';

const ADDR_A = '0x' + 'aa'.repeat(20);
const ADDR_B = '0x' + 'bb'.repeat(20);
const ONE_ETHER = '1000000000000000000';

const TOKEN_A = { address: ADDR_A, decimals: 18, symbol: 'USDC', name: 'USDC' };
const TOKEN_B = { address: ADDR_B, decimals: 18, symbol: 'ETH', name: 'Ether' };

const VALID_REQUEST = {
  chainId: 1,
  fromAddress: ADDR_A,
  inputToken: TOKEN_A,
  outputToken: TOKEN_B,
  amount: '1.5',
  slippageBps: 50,
};

test('exact arithmetic — decimal to base units', () => {
  assert.strictEqual(rail.parseDisplayToBaseUnits('1.5', 18), '1500000000000000000');
  assert.strictEqual(rail.parseDisplayToBaseUnits('1', 18), '1000000000000000000');
  assert.strictEqual(rail.parseDisplayToBaseUnits('0.000000000000000001', 18), '1');
  assert.strictEqual(rail.parseDisplayToBaseUnits('0.5', 18), '500000000000000000');
  assert.strictEqual(rail.parseDisplayToBaseUnits('123.456', 6), '123456000');
  assert.strictEqual(rail.parseDisplayToBaseUnits('1000', 8), '100000000000');
  assert.strictEqual(rail.parseDisplayToBaseUnits('0.999999999999999999', 18), '999999999999999999');
});

test('decimal conversion rejects malformed input', () => {
  assert.throws(() => rail.parseDisplayToBaseUnits('', 18), /invalid_display_amount/);
  assert.throws(() => rail.parseDisplayToBaseUnits('abc', 18), /invalid_display_amount/);
  assert.throws(() => rail.parseDisplayToBaseUnits('1.2.3', 18), /invalid_display_amount/);
  assert.throws(() => rail.parseDisplayToBaseUnits('0', 18), /amount_not_positive/);
  assert.throws(() => rail.parseDisplayToBaseUnits('-0.5', 18), /invalid_display_amount/);
  assert.throws(() => rail.parseDisplayToBaseUnits('1.5', -1), /invalid_decimals/);
  assert.throws(() => rail.parseDisplayToBaseUnits('1.5', 37), /invalid_decimals/);
  assert.throws(() => rail.parseDisplayToBaseUnits('1.0000000000000000001', 18), /amount_exceeds_token_precision/);
  assert.throws(() => rail.parseDisplayToBaseUnits('1' + '0'.repeat(31), 18), /amount_oversized/);
});

test('fee and cashback are 100 bps and 30 bps of notional', () => {
  const stack = rail.buildFeeStack({ amountBaseUnits: ONE_ETHER });
  assert.strictEqual(stack.feeBps, 100);
  assert.strictEqual(stack.feeAmountBaseUnits, '10000000000000000');
  assert.strictEqual(stack.cashbackBps, 30);
  assert.strictEqual(stack.cashbackAmountBaseUnits, '3000000000000000');
  assert.strictEqual(stack.netBaseUnitsAfterFeeAndCashback, '993000000000000000');
  assert.strictEqual(stack.netRateBps, 9930);
  assert.strictEqual(stack.feeRate, 0.01);
  assert.strictEqual(stack.cashbackRate, 0.003);
});

test('fee stack truncates exactly like on-chain integer math', () => {
  const weird = '1000000000000000001';
  const stack = rail.buildFeeStack({ amountBaseUnits: weird });
  assert.strictEqual(stack.feeAmountBaseUnits, '10000000000000000');
  assert.strictEqual(stack.cashbackAmountBaseUnits, '3000000000000000');
});

test('fee stack rejects bad inputs', () => {
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: '0' }), /amount_not_positive/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: '-1' }), /invalid|amount/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: '1000000000000000000000000000000000000000000000000000' }), /amount_oversized/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: null }), /amount_requires_string_or_bigint/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: ONE_ETHER, feeBps: 0 }), /bps_out_of_range/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: ONE_ETHER, feeBps: 5001 }), /bps_out_of_range/);
  assert.throws(() => rail.buildFeeStack({ amountBaseUnits: ONE_ETHER, feeBps: 50.5 }), /bps_out_of_range/);
});

test('quote request builder rejects malformed addresses', () => {
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, fromAddress: '0x1' }), /invalid_evm_address/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, fromAddress: '0x' + 'ff'.repeat(21) }), /invalid_evm_address/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, fromAddress: '0x' + 'gg'.repeat(20) }), /invalid_evm_address/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, fromAddress: '0x' + '00'.repeat(20) }), /address_is_zero/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, fromAddress: '' }), /invalid_evm_address/);
});

test('quote request builder rejects same-token routes', () => {
  const req = { ...VALID_REQUEST, outputToken: { ...TOKEN_A } };
  assert.throws(() => rail.buildQuoteRequest(req), /route_same_tokens/);
});

test('quote request builder rejects unsupported chain IDs', () => {
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: 10 }), /chain_not_supported/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: 137 }), /chain_not_supported/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: 0 }), /invalid_chain_id/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: -1 }), /invalid_chain_id/);
  assert.doesNotThrow(() => rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: '1' }));
});

test('quote request builder rejects invalid decimals on tokens', () => {
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, inputToken: { ...TOKEN_A, decimals: -1 } }), /invalid_decimals/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, inputToken: { ...TOKEN_A, decimals: 37 } }), /invalid_decimals/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, inputToken: { ...TOKEN_A, decimals: 18.5 } }), /invalid_decimals/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, inputToken: 'not-object' }), /token_object_required/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, inputToken: { address: 'bad', decimals: 18 } }), /invalid_evm_address/);
});

test('quote request builder rejects nonpositive and oversized amounts', () => {
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, amount: '0' }), /amount_not_positive/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, amount: '0.0000000000000000001' }), /amount_exceeds_token_precision/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, amount: '1' + '0'.repeat(31), amountIsBaseUnits: true }), /amount_oversized/);
});

test('quote request builder rejects slippage outside 1-5000 bps', () => {
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 0 }), /bps_out_of_range/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 5001 }), /bps_out_of_range/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 50.5 }), /bps_out_of_range/);
  assert.throws(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: -5 }), /bps_out_of_range/);
  assert.doesNotThrow(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 1 }));
  assert.doesNotThrow(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 5000 }));
  assert.doesNotThrow(() => rail.buildQuoteRequest({ ...VALID_REQUEST, slippageBps: 50 }));
});

test('quote request builder accepts supported chains', () => {
  const chains = [1, 56, 4663, 8453];
  for (const id of chains) {
    const req = rail.buildQuoteRequest({ ...VALID_REQUEST, chainId: id, fromAddress: '0x' + 'cc'.repeat(20) });
    assert.strictEqual(req.chainId, id);
  }
});

test('quote request builder includes economics', () => {
  const req = rail.buildQuoteRequest(VALID_REQUEST);
  assert.strictEqual(req.exactInputAmountBaseUnits, '1500000000000000000');
  assert.strictEqual(req.slippageBps, 50);
  assert.strictEqual(req.economics.feeBps, 100);
  assert.strictEqual(req.economics.feeAmountBaseUnits, '15000000000000000');
  assert.strictEqual(req.economics.cashbackBps, 30);
  assert.strictEqual(req.economics.cashbackAmountBaseUnits, '4500000000000000');
  assert.strictEqual(req.economics.netAmountBaseUnitsAfterFees, '1489500000000000000');
});

test('quote request builder supports base-unit amounts', () => {
  const req = rail.buildQuoteRequest({ ...VALID_REQUEST, amount: '1500000000000000000', amountIsBaseUnits: true });
  assert.strictEqual(req.displayAmount, null);
  assert.strictEqual(req.exactInputAmountBaseUnits, '1500000000000000000');
});

test('quote normalizer converts raw payload to canonical shape', () => {
  const raw = {
    chainId: 56,
    fromAddress: '0x' + 'bb'.repeat(20),
    inputToken: { address: ADDR_A, decimals: 6, symbol: 'USDC' },
    outputToken: { address: ADDR_B, decimals: 18 },
    inputAmountBaseUnits: '1000000',
    outputAmountBaseUnits: '993000000000000000',
    minReceivedBaseUnits: '980000000000000000',
    feeAmountBaseUnits: '10000',
    cashbackAmountBaseUnits: '3000',
    feeBps: 100,
    cashbackBps: 30,
    slippageBps: 50,
    quotedAt: '2026-09-14T12:00:00.000Z',
  };
  const norm = rail.normalizeQuote(raw);
  assert.strictEqual(norm.chainId, 56);
  assert.strictEqual(norm.chainIdHex, '0x38');
  assert.strictEqual(norm.chainName, 'BNB');
  assert.strictEqual(norm.fromAddress, '0x' + 'bb'.repeat(20));
  assert.strictEqual(norm.inputAmountBaseUnits, '1000000');
  assert.strictEqual(norm.outputAmountBaseUnits, '993000000000000000');
  assert.strictEqual(norm.minReceivedBaseUnits, '980000000000000000');
  assert.strictEqual(norm.feeAmountBaseUnits, '10000');
  assert.strictEqual(norm.cashbackAmountBaseUnits, '3000');
  assert.strictEqual(norm.feeBps, 100);
  assert.strictEqual(norm.cashbackBps, 30);
  assert.strictEqual(norm.slippageBps, 50);
  assert.strictEqual(norm.quotedAt, '2026-09-14T12:00:00.000Z');
});

test('quote normalizer rejects invalid payloads', () => {
  assert.throws(() => rail.normalizeQuote(null), /quote_object_required/);
  assert.throws(() => rail.normalizeQuote('x'), /quote_object_required/);
  assert.throws(() => rail.normalizeQuote([]), /quote_object_required/);
  assert.throws(() => rail.normalizeQuote({ chainId: 999 }), /chain_not_supported/);
  assert.throws(() => rail.normalizeQuote({ chainId: 1, inputToken: TOKEN_A, outputToken: TOKEN_B }), /amount_field_invalid/);
  assert.throws(() => rail.normalizeQuote({ chainId: 1, inputToken: TOKEN_A, outputToken: TOKEN_B, inputAmountBaseUnits: '0' }), /amount_not_positive/);
  assert.throws(() => rail.normalizeQuote({ chainId: 1, inputToken: TOKEN_A, outputToken: TOKEN_B, inputAmountBaseUnits: '1' + '0'.repeat(31) }), /amount_oversized/);
  assert.throws(() => rail.normalizeQuote({ chainId: 1, inputToken: TOKEN_A, outputToken: TOKEN_B, inputAmountBaseUnits: '100', feeBps: 0 }), /bps_out_of_range/);
  assert.throws(() => rail.normalizeQuote({ chainId: 1, inputToken: TOKEN_A, outputToken: TOKEN_B, inputAmountBaseUnits: '100', slippageBps: 6000 }), /bps_out_of_range/);
});

test('lifecycle — happy path full chain', () => {
  const railObj = rail.createExecutionRail();
  assert.strictEqual(railObj.getState(), 'idle');
  assert.strictEqual(railObj.transition('START_QUOTE'), 'quoting');
  assert.strictEqual(railObj.transition('QUOTE_RECEIVED'), 'quoted');
  assert.strictEqual(railObj.transition('REQUEST_APPROVAL'), 'approval_required');
  assert.strictEqual(railObj.transition('APPROVAL_SUBMITTED'), 'signing');
  assert.strictEqual(railObj.transition('SIGNED'), 'submitted');
  assert.strictEqual(railObj.transition('CONFIRMED'), 'confirmed');
  assert.strictEqual(railObj.isTerminal(), true);
});

test('lifecycle — signed directly from quoted (approval skipped)', () => {
  const r = rail.createExecutionRail();
  r.transition('START_QUOTE');
  r.transition('QUOTE_RECEIVED');
  assert.strictEqual(r.transition('SIGNED'), 'submitted');
  assert.strictEqual(r.transition('CONFIRMED'), 'confirmed');
  assert.strictEqual(r.isTerminal(), true);
});

test('lifecycle — ERROR interrupts any state and lands in failed', () => {
  for (const start of ['idle', 'quoting', 'quoted', 'approval_required', 'signing', 'submitted', 'confirmed', 'failed']) {
    const r = rail.createExecutionRail();
    // reach the start state
    if (start === 'idle') {} else if (start === 'quoting') r.transition('START_QUOTE');
    else if (start === 'quoted') { r.transition('START_QUOTE'); r.transition('QUOTE_RECEIVED'); }
    else if (start === 'approval_required') {
      r.transition('START_QUOTE'); r.transition('QUOTE_RECEIVED'); r.transition('REQUEST_APPROVAL');
    } else if (start === 'signing') {
      r.transition('START_QUOTE'); r.transition('QUOTE_RECEIVED'); r.transition('REQUEST_APPROVAL'); r.transition('APPROVAL_SUBMITTED');
    } else if (start === 'submitted') {
      r.transition('START_QUOTE'); r.transition('QUOTE_RECEIVED'); r.transition('REQUEST_APPROVAL');
      r.transition('APPROVAL_SUBMITTED'); r.transition('SIGNED');
    } else if (start === 'confirmed') {
      r.transition('START_QUOTE'); r.transition('QUOTE_RECEIVED'); r.transition('REQUEST_APPROVAL');
      r.transition('APPROVAL_SUBMITTED'); r.transition('SIGNED'); r.transition('CONFIRMED');
    }
    assert.strictEqual(r.transition('ERROR'), 'failed');
    assert.strictEqual(r.isTerminal(), true);
  }
});

test('lifecycle — FAILED is terminal and loops on itself', () => {
  const r = rail.createExecutionRail();
  r.transition('START_QUOTE');
  r.transition('ERROR');
  assert.strictEqual(r.getState(), 'failed');
  assert.strictEqual(r.isTerminal(), true);
  assert.strictEqual(r.transition('ERROR'), 'failed');
});

test('state reducer rejects unknown transitions with a helpful message', () => {
  const r = rail.createExecutionRail();
  r.transition('START_QUOTE');
  assert.throws(() => r.transition('BAD_ACTION'), /invalid_state_transition/);
  assert.throws(() => r.transition('BAD_ACTION'), /permitted from this state: QUOTE_RECEIVED, ERROR/);
});

test('railReducer rejects unknown initial state', () => {
  assert.throws(() => rail.railReducer('weird', 'START_QUOTE'), /unknown_initial_state/);
});

test('transition helpers report permitted events correctly', () => {
  const r = rail.createExecutionRail();
  assert.strictEqual(r.canTransition('START_QUOTE'), true);
  assert.strictEqual(r.canTransition('QUOTE_RECEIVED'), false);
  r.transition('START_QUOTE');
  r.transition('QUOTE_RECEIVED');
  assert.strictEqual(r.canTransition('REQUEST_APPROVAL'), true);
  assert.strictEqual(r.canTransition('SIGNED'), true);
  assert.strictEqual(r.canTransition('START_QUOTE'), false);
  assert.strictEqual(rail.canTransition('quoted', 'REQUEST_APPROVAL'), true);
  assert.strictEqual(rail.canTransition('idle', 'QUOTE_RECEIVED'), false);
});

test('exported API exposes no secret or environment field names', () => {
  const forbiddenKeys = ['privateKey', 'private_key', 'seed', 'mnemonic', 'keystore', 'password', 'passphrase', 'secret', 'accessKey', 'access_key', 'token', 'hostOrigin', 'rpcUrl', 'rpcUrl', 'providerUrl'];
  const api = Object.keys(rail);
  for (const key of api) {
    assert.doesNotMatch(key, /password|secret|key|phrase|mnemonic|seed|token|origin|rpcurl|providerurl|wallet|ledger/i, `forbidden secret-like field: ${key}`);
  }
});

test('module source contains no forbidden browser/secret APIs', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../dist/execution-rail.js', import.meta.url), 'utf8');
  const forbidden = ['localStorage', 'document.cookie', 'window.ethereum', 'navigator', '.cookie', 'fetch(', 'privateKey', 'seedPhrase', 'mnemonic', 'keystore'];
  for (const token of forbidden) {
    assert.ok(!source.includes(token), `forbidden token present in source: ${token}`);
  }
});

test('module exports all required symbols', () => {
  const required = [
    'EXECUTION_FEE_BPS',
    'NOTIONAL_CASHBACK_BPS',
    'parseDisplayToBaseUnits',
    'buildFeeStack',
    'buildQuoteRequest',
    'normalizeQuote',
    'railReducer',
    'createExecutionRail',
    'RAIL_STATE_NAMES',
    'SUPPORTED_CHAIN_IDS',
    'validateEvmAddress',
  ];
  for (const name of required) {
    assert.ok(name in rail, `${name} must be exported`);
  }
});
