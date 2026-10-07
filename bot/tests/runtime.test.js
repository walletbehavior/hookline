import assert from 'node:assert/strict';
import test from 'node:test';

import { handleUpdate } from '../index.js';
import { parseMessage, verifyWebhookSecret } from '../bot-api.js';
import { feeMicros, cashbackMicros } from '../fees.js';
import { buyPresets, sellPresets, KEYS } from '../keys.js';
import { parseDisplayToBaseUnits, buildSimulatedQuote } from '../quote.js';
import { buildPreviewReceipt, sanitizeValue } from '../receipts.js';

const TOKEN = '0x56c915d92e24255fdc52eb114a31399c432b7cc6';
const HOOK = '0x0ee851f1fe2f4bdba79fee78969e329c136ca0cc';
const BOT_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyzABCDE';

class MockTelegramClient {
  static calls = [];

  constructor() {}

  async sendMessage(chatId, text, options = {}) {
    MockTelegramClient.calls.push({ type: 'send', chatId, text, options });
    return { message_id: 10 };
  }

  async answerCallbackQuery(id, options = {}) {
    MockTelegramClient.calls.push({ type: 'answer', id, options });
    return true;
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    MockTelegramClient.calls.push({ type: 'edit', chatId, messageId, text, options });
    return { message_id: messageId };
  }
}

function command(text) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 7 },
      chat: { id: 7 },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  };
}

function callback(data) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      from: { id: 7 },
      data,
      message: { message_id: 10, chat: { id: 7 } },
    },
  };
}

const relationships = [{
  chainId: 1,
  hookAddress: HOOK,
  hookName: 'Engram Hook',
  hookNamed: true,
  poolId: `1_0x${'ab'.repeat(32)}`,
  pairLabel: 'ENGRAM / WETH',
  baseToken: { address: TOKEN, symbol: 'ENGRAM', name: 'Engram' },
  quoteToken: { address: '0x0000000000000000000000000000000000000001', symbol: 'WETH', name: 'Wrapped Ether' },
  priceUsd: 0.0004,
  priceChangeH24: 205,
  liquidityUsd: 62_000,
  volumeUsd: 499_000,
  transactions: 1_821,
}];

const services = {
  resolveTokenHooks: async (query) => ({ query, relationships }),
  resolveHookMarkets: async (chainId, hookAddress) => ({
    chainId,
    hook: hookAddress,
    totalPoolsReturned: 1,
    profile: {
      project: { name: 'Engram Hook' },
      verifiedContract: null,
    },
    relationships,
    markets: relationships,
  }),
};

test.beforeEach(() => {
  MockTelegramClient.calls = [];
  globalThis.TelegramClient = MockTelegramClient;
});

test.after(() => {
  delete globalThis.TelegramClient;
});

test('parses bot commands with and without Telegram entities', () => {
  assert.equal(parseMessage(command('/start').message).command, 'start');
  assert.equal(parseMessage({ chat: { id: 1 }, from: { id: 1 }, text: '/help' }).command, 'help');
});

test('verifies the Telegram webhook secret', () => {
  const request = new Request('https://hookline.world/telegram/webhook', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
  });
  assert.equal(verifyWebhookSecret(request, 'secret').ok, true);
  assert.equal(verifyWebhookSecret(request, 'wrong').ok, false);
});

test('fee and cashback are 1% and 0.3% of notional', () => {
  assert.equal(feeMicros(100), '1000000');
  assert.equal(cashbackMicros('1000000'), '300000');
  const quote = buildSimulatedQuote({
    chainId: 1,
    side: 'buy',
    inputToken: { address: TOKEN, symbol: 'ENGRAM' },
    notionalUsd: 100,
  });
  assert.equal(quote.feeUsdc, 1);
  assert.equal(quote.cashbackUsdc, 0.3);
});

test('base-unit conversion stays exact at 18 decimals', () => {
  assert.equal(parseDisplayToBaseUnits('1.5', 18), '1500000000000000000');
  assert.throws(() => parseDisplayToBaseUnits('0', 18));
});

test('callback payloads remain within Telegram 64-byte limit', () => {
  const buttons = [
    ...buyPresets(42161, TOKEN),
    ...sellPresets(42161, TOKEN),
    KEYS.hook(42161, HOOK),
    KEYS.related(42161, HOOK),
    KEYS.sibling(42161, TOKEN, 'ENGRAM'),
  ];
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
  }
});

test('sanitizes wallet secrets from receipts', () => {
  const circular = { private_key: 'never', nested: { seed_phrase: 'never', ok: true } };
  circular.self = circular;
  assert.deepEqual(sanitizeValue(circular), { nested: { ok: true }, self: '[circular]' });
});

test('builds a deterministic preview receipt without signing material', () => {
  const quote = buildSimulatedQuote({
    chainId: 1,
    side: 'buy',
    inputToken: { address: TOKEN, symbol: 'ENGRAM' },
    notionalUsd: 100,
  });
  const readiness = { ready: false, reason: 'wallet not connected' };
  const a = buildPreviewReceipt(1, quote, readiness);
  const b = buildPreviewReceipt(1, quote, readiness);
  assert.equal(a.receipt_id, b.receipt_id);
  assert.equal(a.tx_hash, null);
  assert.equal(a.fee_usdc_micros, '1000000');
  assert.equal(a.cashback_usdc_micros, '300000');
});

test('renders start and ENGRAM token lookup', async () => {
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services };
  const started = await handleUpdate(command('/start'), ctx);
  assert.equal(started.handled, true);
  assert.match(MockTelegramClient.calls[0].text, /Paste a token or hook address/);
  assert.doesNotMatch(MockTelegramClient.calls[0].text, /1% fee/);

  MockTelegramClient.calls = [];
  const lookedUp = await handleUpdate(command(`/token ${TOKEN}`), ctx);
  assert.equal(lookedUp.found, true);
  const sent = MockTelegramClient.calls.find((item) => item.type === 'send');
  assert.match(sent.text, /ENGRAM/);
  assert.match(sent.text, /Engram Hook/);
  assert.match(sent.text, /205\.00%/);
});

test('opens a website hook deep link on its supplied chain without scanning other chains', async () => {
  const calls = [];
  const directServices = {
    ...services,
    resolveHookMarkets: async (chainId, hookAddress) => {
      calls.push({ chainId, hookAddress });
      return services.resolveHookMarkets(chainId, hookAddress);
    },
  };
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services: directServices };
  const result = await handleUpdate(command(`/start hook_8453_${HOOK.slice(2)}`), ctx);
  assert.equal(result.found, true);
  assert.deepEqual(calls, [{ chainId: 8453, hookAddress: HOOK }]);
  const sent = MockTelegramClient.calls.find((item) => item.type === 'send');
  assert.match(sent.text, /Engram Hook/);
});

test('keeps fee disclosure in about instead of the start screen', async () => {
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services };
  await handleUpdate(command('/about'), ctx);
  const sent = MockTelegramClient.calls.find((item) => item.type === 'send');
  assert.match(sent.text, /Execution fee: 1%/);
  assert.match(sent.text, /User cashback: 0\.3%/);
});

test('navigates hook and buy preview callbacks by editing in place', async () => {
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services };
  await handleUpdate(command(`/token ${TOKEN}`), ctx);
  MockTelegramClient.calls = [];

  const hookResult = await handleUpdate(callback(`tg:hook:1:${HOOK}`), ctx);
  assert.equal(hookResult.kind, 'hook');
  assert.equal(MockTelegramClient.calls.filter((item) => item.type === 'answer').length, 1);
  assert.equal(MockTelegramClient.calls.filter((item) => item.type === 'edit').length, 1);

  MockTelegramClient.calls = [];
  const grid = await handleUpdate(callback(`tg:buy:1:${TOKEN}`), ctx);
  assert.equal(grid.kind, 'preset_grid');
  const edit = MockTelegramClient.calls.find((item) => item.type === 'edit');
  assert.match(edit.text, /Buy preset/);

  MockTelegramClient.calls = [];
  const preview = await handleUpdate(callback(`tg:bp:1:${TOKEN}:100`), ctx);
  assert.equal(preview.kind, 'preview');
  assert.match(MockTelegramClient.calls.find((item) => item.type === 'edit').text, /Cashback \(0\.3%\)/);
});
