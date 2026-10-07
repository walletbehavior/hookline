import assert from 'node:assert/strict';
import test from 'node:test';

import { handleUpdate } from '../index.js';
import { alertEvents, runAlertScan } from '../alert-runner.js';
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

function memoryAlerts() {
  const rows = [];
  return {
    rows,
    async listUserAlerts(userId,{includePaused=false}={}) {
      return rows.filter((row) => row.telegram_user_id === String(userId) && (includePaused || row.enabled));
    },
    async createOrEnableAlert({ userId, chatId, chainId, address }) {
      const existing = rows.find((row) =>
        row.telegram_user_id === String(userId)
        && row.chat_id === String(chatId)
        && row.chain_id === Number(chainId)
        && row.target_address === address.toLowerCase());
      if (existing) existing.enabled = 1;
      else rows.push({
        id: rows.length + 1,
        telegram_user_id: String(userId),
        chat_id: String(chatId),
        chain_id: Number(chainId),
        target_address: address.toLowerCase(),
        enabled: 1,
        baseline_json: null,
      });
      return { created: !existing };
    },
    async disableAlert({ userId, chainId, address }) {
      const row = rows.find((item) =>
        item.telegram_user_id === String(userId)
        && item.chain_id === Number(chainId)
        && item.target_address === address.toLowerCase());
      if (!row || !row.enabled) return false;
      row.enabled = 0;
      return true;
    },
  };
}

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
  assert.match(sent.text, /Gross execution fee: 1%/);
  assert.match(sent.text, /Instant cashback: 0\.3%/);
  assert.match(sent.text, /Effective fee: 0\.7%/);
});

test('navigates hook and real trade handoffs by editing in place, including legacy callbacks', async () => {
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services };
  await handleUpdate(command(`/token ${TOKEN}`), ctx);
  MockTelegramClient.calls = [];

  const hookResult = await handleUpdate(callback(`tg:hook:1:${HOOK}`), ctx);
  assert.equal(hookResult.kind, 'hook');
  assert.equal(MockTelegramClient.calls.filter((item) => item.type === 'answer').length, 1);
  assert.equal(MockTelegramClient.calls.filter((item) => item.type === 'edit').length, 1);

  MockTelegramClient.calls = [];
  const grid = await handleUpdate(callback(`tg:buy:1:${TOKEN}`), ctx);
  assert.equal(grid.kind, 'trade_handoff');
  const edit = MockTelegramClient.calls.find((item) => item.type === 'edit');
  assert.match(edit.text, /Buy review/);
  assert.ok(edit.options.reply_markup.inline_keyboard.flat().some(button=>button.url?.includes('#/trade/1/')));

  MockTelegramClient.calls = [];
  const preview = await handleUpdate(callback(`tg:bp:1:${TOKEN}:100`), ctx);
  assert.equal(preview.kind, 'trade_handoff');
  const previewText = MockTelegramClient.calls.find((item) => item.type === 'edit').text;
  assert.match(previewText, /old USD preset was not applied/);
  assert.doesNotMatch(previewText, /minimum received|minimum output|simulated|\$100/i);
});

test('confirms, enables, lists and disables a hook alert', async () => {
  const alerts = memoryAlerts();
  const ctx = { env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, services: { ...services, alerts } };
  const setup = await handleUpdate(command(`/start alert_8453_${HOOK.slice(2)}`), ctx);
  assert.equal(setup.handled, true);
  const card = MockTelegramClient.calls.find((item) => item.type === 'send');
  assert.match(card.text, /Enable hook alert/);
  assert.equal(card.options.reply_markup.inline_keyboard[0][0].callback_data, `tg:ae:8453:${HOOK}`);
  assert.ok(Buffer.byteLength(card.options.reply_markup.inline_keyboard[0][0].callback_data) <= 64);

  MockTelegramClient.calls = [];
  const enabled = await handleUpdate(callback(`tg:ae:8453:${HOOK}`), ctx);
  assert.equal(enabled.kind, 'alert_enabled');
  assert.equal(alerts.rows.length, 1);
  assert.equal(MockTelegramClient.calls[0].type, 'edit');
  assert.equal(MockTelegramClient.calls[1].type, 'answer');

  MockTelegramClient.calls = [];
  await handleUpdate(command('/alerts'), ctx);
  const list = MockTelegramClient.calls.find((item) => item.type === 'send');
  assert.match(list.text, /Base/);
  assert.match(list.text, /1 of 10/);

  MockTelegramClient.calls = [];
  const disabled = await handleUpdate(callback(`tg:ad:8453:${HOOK}`), ctx);
  assert.equal(disabled.kind, 'alert_disabled');
  assert.equal(alerts.rows[0].enabled, 0);
});

test('alert runner seeds silently, then delivers liquidity and runtime events', async () => {
  const alert = {
    id: 1,
    telegram_user_id: '7',
    chat_id: '7',
    chain_id: 8453,
    target_address: HOOK,
    baseline_json: null,
  };
  const deliveries = new Set();
  const sent = [];
  const store = {
    async listDueAlerts() { return [alert]; },
    async updateBaseline({ baseline }) { alert.baseline_json = JSON.stringify(baseline); },
    async reschedule() {},
    async hasDelivery(_id, key) { return deliveries.has(key); },
    async recordDelivery(_id, key) { deliveries.add(key); },
  };
  let liquidityUsd = 100;
  let runtimeFingerprint = 'a'.repeat(64);
  const resolveHookMarkets = async () => ({
    profile:{verifiedContract:{name:'Observed Hook'}},
    markets: [{ pairAddress: `0x${'ab'.repeat(32)}`, liquidityUsd }],
  });
  const inspectHook = async () => ({
    runtimeFingerprint: { algorithm: 'SHA-256', fingerprint: runtimeFingerprint },
    codeByteLength: 512,
  });
  const sendMessage = async (chatId, text,options) => sent.push({ chatId, text,options });

  const seeded = await runAlertScan({}, { store, resolveHookMarkets, inspectHook, sendMessage, now: 1 });
  assert.equal(seeded.seeded, 1);
  assert.equal(sent.length, 0);

  liquidityUsd = 112;
  const delivered = await runAlertScan({}, { store, resolveHookMarkets, inspectHook, sendMessage, now: 2 });
  assert.equal(delivered.delivered, 1);
  assert.match(sent[0].text, /rose 12\.0%/);
  assert.match(sent[0].text, /Indexed liquidity/);
  assert.match(sent[0].text,/Observed Hook/);
  assert(sent[0].text.includes(`<code>${HOOK}</code>`));
  assert.equal(sent[0].options.parse_mode,'HTML');
  assert(sent[0].options.reply_markup.inline_keyboard.flat().some(button=>button.callback_data===`tg:ad:8453:${HOOK}`));

  runtimeFingerprint = 'b'.repeat(64);
  const runtimeChanged = await runAlertScan({}, { store, resolveHookMarkets, inspectHook, sendMessage, now: 3 });
  assert.equal(runtimeChanged.delivered, 1);
  assert.match(sent[1].text, /Runtime bytecode changed/);
  assert.equal(alertEvents(
    { poolIds: ['a'], aggregateLiquidityUsd: 100 },
    { poolIds: ['a', 'b'], aggregateLiquidityUsd: 100 },
  )[0].kind, 'new_pool');
});

test('liquidity alerts require complete measurements of the same indexed pool set',()=>{
  const before={poolIds:['a'],aggregateLiquidityUsd:100,liquidityComplete:true};
  const after={poolIds:['a'],aggregateLiquidityUsd:120,liquidityComplete:true};
  assert.equal(alertEvents(before,after)[0].kind,'liquidity');
  assert.equal(alertEvents(before,{...after,liquidityComplete:false}).length,0);
  assert.equal(alertEvents({...before,liquidityComplete:undefined},after).length,0);
  assert.ok(!alertEvents(before,{...after,poolIds:['b']}).some(event=>event.kind==='liquidity'));
  assert.ok(!alertEvents(before,{...after,poolIds:[],aggregateLiquidityUsd:0,liquidityComplete:false}).length);
});

test('first-party pool alerts seed silently and carry source evidence',async()=>{
  const alert={id:2,telegram_user_id:'7',chat_id:'7',chain_id:8453,target_address:HOOK,baseline_json:null};
  const deliveries=new Set(),sent=[];
  const store={async listDueAlerts(){return [alert];},async updateBaseline({baseline}){alert.baseline_json=JSON.stringify(baseline);},async reschedule(){},
    async hasDelivery(_id,key){return deliveries.has(key);},async recordDelivery(_id,key){deliveries.add(key);}};
  const pool=(digit,block)=>({poolId:`0x${digit.repeat(64)}`,transactionHash:`0x${String(Number(digit)+1).repeat(64)}`,blockNumber:block,logIndex:3});
  let pools=[pool('1',100)];
  const resolveFirstPartyPools=async()=>({available:true,complete:true,liveFrom:90,liveThrough:110,pools});
  const resolveHookMarkets=async()=>({profile:{project:{name:'Measured Hook'}},markets:[]});
  const sendMessage=async(chatId,text,options)=>sent.push({chatId,text,options});
  const seeded=await runAlertScan({}, {store,resolveHookMarkets,resolveFirstPartyPools,sendMessage,now:1});
  assert.equal(seeded.seeded,1);assert.equal(sent.length,0);
  pools=[pool('2',112),...pools];
  const delivered=await runAlertScan({}, {store,resolveHookMarkets,resolveFirstPartyPools,sendMessage,now:2});
  assert.equal(delivered.delivered,1);assert.match(sent[0].text,/new finalized Base pool/);assert.match(sent[0].text,/Measured Hook/);
  assert.match(sent[0].text,/Source transaction/);assert(sent[0].text.includes(`<code>${pools[0].transactionHash}</code>`));
  assert.equal(sent[0].options.reply_markup.inline_keyboard[0][0].url,`https://hookline.world/#/tape/8453/${HOOK}`);
  const before=JSON.parse(alert.baseline_json);
  await runAlertScan({}, {store,resolveHookMarkets,resolveFirstPartyPools:async()=>({available:true,complete:false,pools:[pool('3',113)]}),sendMessage,now:3});
  assert.deepEqual(JSON.parse(alert.baseline_json).firstPartyPools,before.firstPartyPools,'Incomplete coverage must retain the last complete baseline.');
});
