// Hookline Telegram bot runtime. This file is Cloudflare Worker compatible.
'use strict';

import {
  parseUpdate,
  parseMessage,
  TelegramClient,
} from './bot-api.js';
import { CHAIN_CONFIG, SUPPORTED_CHAINS } from './chains.js';
import {
  resolveHookMarkets as resolveHookMarketsFallback,
  resolveTokenHooks as resolveTokenHooksFallback,
} from './market.js';
import { normalizeTokenIdentity, validateEvmAddress } from './wallets.js';
import { renderTokenCard, renderPresetGrid } from './token-view.js';
import { renderHookView } from './hook-view.js';
import { renderTradePreview } from './preview.js';
import {
  AlertStorageUnavailableError,
  makeD1AlertStore,
  MAX_ALERTS_PER_USER,
} from './alerts-store.js';

const SESSIONS = new Map();

function sessionKey(update) {
  return String(update.message?.from?.id ?? update.callback_query?.from?.id ?? '');
}

function getSession(userId) {
  return SESSIONS.get(userId) || null;
}

function setSession(userId, session) {
  SESSIONS.set(userId, session);
  if (SESSIONS.size > 2_000) {
    for (const key of [...SESSIONS.keys()].slice(0, 500)) SESSIONS.delete(key);
  }
}

function makeClient(env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const Client = globalThis.TelegramClient || TelegramClient;
    const client = new Client(token);
    return {
      reply: (chatId, text, options) => client.sendMessage(chatId, text, options),
      answer: (id, options = {}) => client.answerCallbackQuery(id, options),
      edit: (chatId, messageId, text, options) =>
        client.editMessageText(chatId, messageId, text, options),
    };
  } catch {
    return null;
  }
}

function tokenFromRelationship(address, relationship) {
  const normalized = address.toLowerCase();
  const candidates = [relationship?.baseToken, relationship?.quoteToken].filter(Boolean);
  const match = candidates.find((token) => token?.address?.toLowerCase() === normalized);
  return normalizeTokenIdentity(match || { address: normalized, symbol: 'TOKEN', name: '' });
}

function marketFromRelationship(relationship) {
  return {
    poolId: relationship.poolId || null,
    poolName: relationship.poolName || relationship.pairLabel || null,
    pairAddress: relationship.poolId?.split('_').pop() || null,
    baseToken: relationship.baseToken || null,
    quoteToken: relationship.quoteToken || null,
    priceUsd: relationship.priceUsd ?? null,
    priceChangeH24: relationship.priceChangeH24 ?? null,
    liquidityUsd: relationship.liquidityUsd ?? null,
    volumeUsd: relationship.volumeUsd ?? null,
    txnsH24: relationship.transactions ?? null,
    marketCapUsd: relationship.marketCapUsd ?? relationship.fdvUsd ?? null,
  };
}

async function tokenRelationships(ctx, address) {
  const resolver = ctx.services?.resolveTokenHooks || resolveTokenHooksFallback;
  try {
    const result = await resolver(address.toLowerCase());
    return Array.isArray(result?.relationships) ? result.relationships : [];
  } catch {
    return [];
  }
}

async function hookMarkets(ctx, chainId, hookAddress) {
  const resolver = ctx.services?.resolveHookMarkets || resolveHookMarketsFallback;
  try {
    return await resolver(Number(chainId), hookAddress.toLowerCase());
  } catch {
    return null;
  }
}

function sessionForRelationship(address, relationship, relationships) {
  return {
    chainId: Number(relationship.chainId),
    address: address.toLowerCase(),
    hookAddress: relationship.hookAddress?.toLowerCase() || null,
    siblings: relationships.filter(
      (item) =>
        Number(item.chainId) === Number(relationship.chainId) &&
        item.hookAddress?.toLowerCase() === relationship.hookAddress?.toLowerCase()
    ),
  };
}

async function editCard(client, callbackQuery, card) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (chatId != null && messageId != null) {
    await client.edit(chatId, messageId, card.text, {
      parse_mode: card.parse_mode || 'Markdown',
      reply_markup: card.reply_markup,
      disable_web_page_preview: true,
    });
  }
  await client.answer(callbackQuery.id);
}

export async function handleUpdate(update, ctx = {}) {
  const event = parseUpdate(update);
  if (!event.valid) return { handled: false, reason: event.reason };
  const userId = String(ctx.userIdResolver ? ctx.userIdResolver(update) : sessionKey(update));
  if (event.kind === 'message') return handleMessage(event.message, ctx, userId);
  if (event.kind === 'callback_query') return handleCallback(event.callback_query, ctx, userId);
  return { handled: false, reason: 'unsupported_update' };
}

async function handleMessage(message, ctx, userId) {
  const client = makeClient(ctx.env);
  if (!client) return { handled: false, reason: 'telegram_not_configured' };
  const parsed = parseMessage(message);

  if (parsed.kind === 'command') {
    const command = parsed.command.toLowerCase().split('@')[0];
    if (command === 'start') return startCommand(client, parsed, ctx, userId);
    if (command === 'help') return helpCommand(client, parsed);
    if (command === 'about' || command === 'fees') return aboutCommand(client, parsed);
    if (command === 'alerts' || command === 'alert') return alertsCommand(client, parsed, ctx, userId);
    if (command === 'wallet') return walletCommand(client, parsed);
    if (command === 'positions') return positionsCommand(client, parsed);
    if (command === 'settings') return settingsCommand(client, parsed);
    if (command === 'token') {
      const address = validateEvmAddress(parsed.args);
      if (!address) return promptForAddress(client, parsed.chatId, '/token');
      return tokenLookup(client, ctx, parsed.chatId, userId, address);
    }
    if (command === 'hook') {
      const address = validateEvmAddress(parsed.args);
      if (!address) return promptForAddress(client, parsed.chatId, '/hook');
      return hookLookup(client, ctx, parsed.chatId, userId, address);
    }
    return helpCommand(client, parsed);
  }

  if (parsed.kind === 'evm_contract_lookup') {
    const tokenResult = await tokenLookup(client, ctx, parsed.chatId, userId, parsed.address, true);
    if (tokenResult.found) return tokenResult;
    return hookLookup(client, ctx, parsed.chatId, userId, parsed.address, true);
  }

  return helpCommand(client, parsed);
}

async function startCommand(client, parsed, ctx, userId) {
  const deepLink = String(parsed.args || '').match(/^(hook|alert)_(\d+)_(?:0x)?([0-9a-fA-F]{40})$/);
  if (deepLink) {
    const address = `0x${deepLink[3].toLowerCase()}`;
    if (deepLink[1] === 'hook') {
      return hookLookup(client, ctx, parsed.chatId, userId, address, false, Number(deepLink[2]));
    }
    return alertsCommand(client, {
      ...parsed,
      args: `${deepLink[2]}:${address}`,
    }, ctx, userId);
  }
  const text = [
    '🪝 *Hookline*',
    '',
    'Paste a token or hook address. I\'ll map the token, its hook, related pools and sibling tokens.',
    '',
    '*Commands*',
    '*/token <address>*  token, hook and market data',
    '*/hook <address>*   hook and related tokens',
    '*/alerts*           Telegram alert setup',
    '*/wallet*           user-owned wallet setup',
    '*/positions*        position status',
    '*/settings*         bot settings',
    '*/about*            product and fee details',
    '*/help*             usage',
    '',
    'Never send a seed phrase or private key here.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  return { handled: true, messageId: reply?.message_id };
}

async function helpCommand(client, parsed) {
  const text = [
    '*Use Hookline in Telegram*',
    '',
    'Paste an EVM address or use */token* and */hook*.',
    'Tap Hook to inspect the hook, Related tokens to see sibling assets, DexScreener for charts, or Buy preview for fee math.',
    '',
    'Data comes from Hookline\'s hook index, v4.xyz and DexScreener.',
    'No transaction is submitted from the current bot. Use */about* for product and fee details.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, { parse_mode: 'Markdown' });
  return { handled: true, messageId: reply?.message_id };
}

async function aboutCommand(client, parsed) {
  const text = [
    '*About Hookline*',
    '',
    'Hookline maps tokens, hooks, pools and sibling markets across chains.',
    '',
    '*Trading fees*',
    'Execution fee: 1% of trade notional',
    'User cashback: 0.3% of trade notional',
    '',
    'Execution is not active until user-owned wallet signing is connected. Discovery, market links and previews are available now.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, { parse_mode: 'Markdown' });
  return { handled: true, messageId: reply?.message_id };
}

async function promptForAddress(client, chatId, command) {
  const reply = await client.reply(chatId, `Use *${command} 0x...*`, { parse_mode: 'Markdown' });
  return { handled: true, found: false, messageId: reply?.message_id };
}

function alertsStore(ctx) {
  return ctx.services?.alerts || makeD1AlertStore(ctx.env);
}

function alertTarget(chainId, address) {
  const chain = CHAIN_CONFIG[Number(chainId)]?.name || `Chain ${chainId}`;
  return `${chain}, ${address.slice(0, 6)}...${address.slice(-6)}`;
}

async function alertsCommand(client, parsed, ctx, userId) {
  const args = String(parsed.args || '').trim();
  const argMatch = args.match(/^(\d+):(0x[0-9a-fA-F]{40})$/i);

  if (argMatch) {
    const chainId = Number(argMatch[1]);
    const address = argMatch[2].toLowerCase();
    if (!SUPPORTED_CHAINS.includes(chainId)) {
      const reply = await client.reply(
        parsed.chatId,
        `Unsupported chain ${chainId}. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
      );
      return { handled: true, messageId: reply?.message_id };
    }
    const reply = await client.reply(
      parsed.chatId,
      [
        '*Enable hook alert?*',
        '',
        alertTarget(chainId, address),
        'Checks every 10 minutes for runtime changes, new indexed pool relationships, or indexed liquidity movement of 10% or more.',
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Enable', callback_data: `tg:ae:${chainId}:${address}` },
            { text: 'Cancel', callback_data: `tg:ac:${chainId}:${address}` },
          ]],
        },
      },
    );
    return { handled: true, messageId: reply?.message_id };
  }

  try {
    const list = await alertsStore(ctx).listUserAlerts(userId);
    if (!list.length) {
      const reply = await client.reply(
        parsed.chatId,
        '*Your alerts*\n\nNo alerts enabled. Open a hook on hookline.world and tap Telegram alerts.',
        { parse_mode: 'Markdown' },
      );
      return { handled: true, messageId: reply?.message_id };
    }
    const lines = ['*Your alerts*', ''];
    const keyboard = [];
    for (const alert of list) {
      lines.push(alertTarget(alert.chain_id, alert.target_address));
      keyboard.push([{
        text: `Disable ${alert.target_address.slice(0, 6)}...${alert.target_address.slice(-4)}`,
        callback_data: `tg:ad:${alert.chain_id}:${alert.target_address}`,
      }]);
    }
    lines.push('', `${list.length} of ${MAX_ALERTS_PER_USER} alert slots used.`);
    const reply = await client.reply(parsed.chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
    return { handled: true, messageId: reply?.message_id };
  } catch (error) {
    const unavailable = error instanceof AlertStorageUnavailableError;
    const reply = await client.reply(
      parsed.chatId,
      unavailable
        ? '*Alerts are temporarily unavailable*\n\nHook and token lookup still works.'
        : '*Alerts could not load*\n\nTry again in a moment.',
      { parse_mode: 'Markdown' },
    );
    return { handled: true, messageId: reply?.message_id };
  }
}

async function walletCommand(client, parsed) {
  const reply = await client.reply(
    parsed.chatId,
    '*User-owned wallet*\n\nHookline will use Privy embedded wallets. You own the wallet and can export it. Hookline will only request narrowly scoped signing permission after explicit consent. Setup isn\'t active yet.',
    { parse_mode: 'Markdown' }
  );
  return { handled: true, messageId: reply?.message_id };
}

async function positionsCommand(client, parsed) {
  const reply = await client.reply(
    parsed.chatId,
    '*Positions*\n\nPosition tracking activates with wallet connection. No wallet is connected to this Telegram account yet.',
    { parse_mode: 'Markdown' }
  );
  return { handled: true, messageId: reply?.message_id };
}

async function settingsCommand(client, parsed) {
  const reply = await client.reply(
    parsed.chatId,
    '*Settings*\n\nCurrent mode: discovery and trade preview\nExecution: off\nAlerts: live\nWallet: not connected\n\nFee details: /about',
    { parse_mode: 'Markdown' }
  );
  return { handled: true, messageId: reply?.message_id };
}

async function tokenLookup(client, ctx, chatId, userId, address, silentMiss = false) {
  const relationships = await tokenRelationships(ctx, address);
  if (!relationships.length) {
    if (silentMiss) return { handled: true, found: false };
    const reply = await client.reply(chatId, `No token relationship found for \`${address}\`.`, {
      parse_mode: 'Markdown',
    });
    return { handled: true, found: false, messageId: reply?.message_id };
  }

  const relation = relationships[0];
  const token = tokenFromRelationship(address, relation);
  const sameToken = relationships.filter((item) => Number(item.chainId) === Number(relation.chainId));
  const markets = sameToken.map(marketFromRelationship);
  const hookInfo = relation.hookAddress
    ? {
        hookAddress: relation.hookAddress,
        hookName: relation.hookName || 'Hook',
        hookNamed: Boolean(relation.hookNamed || relation.hookName),
      }
    : null;
  const card = renderTokenCard(token, relation.chainId, hookInfo, markets);
  setSession(userId, sessionForRelationship(address, relation, relationships));
  const reply = await client.reply(chatId, card.text, {
    parse_mode: 'Markdown',
    reply_markup: card.reply_markup,
    disable_web_page_preview: true,
  });
  return { handled: true, found: true, messageId: reply?.message_id, card };
}

async function findHook(ctx, hookAddress, preferredChainId = null) {
  if (Number.isSafeInteger(preferredChainId) && preferredChainId > 0) {
    const result = await hookMarkets(ctx, preferredChainId, hookAddress);
    if (result && (result.profile || result.markets?.length || result.relationships?.length || result.totalPoolsReturned)) {
      return { chainId: preferredChainId, result };
    }
    return null;
  }
  for (const chainId of SUPPORTED_CHAINS) {
    const result = await hookMarkets(ctx, chainId, hookAddress);
    if (result && (result.markets?.length || result.relationships?.length || result.totalPoolsReturned)) {
      return { chainId, result };
    }
  }
  return null;
}

async function hookLookup(client, ctx, chatId, userId, hookAddress, silentMiss = false, preferredChainId = null) {
  const found = await findHook(ctx, hookAddress, preferredChainId);
  if (!found) {
    const message = silentMiss ? 'No Hookline relationship found' : 'No hook profile found';
    const reply = await client.reply(chatId, `${message} for \`${hookAddress}\`.`, {
      parse_mode: 'Markdown',
    });
    return { handled: true, found: false, messageId: reply?.message_id };
  }

  const relationships = found.result.relationships || found.result.markets || [];
  const token = { address: hookAddress, symbol: 'HOOK', name: '' };
  const card = renderHookView(
    token,
    found.chainId,
    {
      hookAddress,
      hookName: found.result.profile?.project?.name || found.result.profile?.verifiedContract?.name || 'Hook',
      hookNamed: Boolean(found.result.profile?.project || found.result.profile?.verifiedContract),
    },
    relationships,
    0
  );
  setSession(userId, {
    chainId: found.chainId,
    address: hookAddress,
    hookAddress,
    siblings: relationships,
  });
  const reply = await client.reply(chatId, card.text, {
    parse_mode: 'Markdown',
    reply_markup: card.reply_markup,
    disable_web_page_preview: true,
  });
  return { handled: true, found: true, messageId: reply?.message_id, card };
}

async function handleCallback(callbackQuery, ctx, userId) {
  const client = makeClient(ctx.env);
  if (!client) return { handled: false, reason: 'telegram_not_configured' };
  const match = String(callbackQuery.data || '').match(
    /^tg:([a-z]+)(?::([^:]+))?(?::([^:]+))?(?::([^:]+))?$/
  );
  if (!match) return invalidCallback(client, callbackQuery, 'Invalid action');

  const [, action, p1, p2, p3] = match;
  const session = getSession(userId);

  if (action === 'ac') {
    await editCard(client, callbackQuery, { text: 'Alert setup cancelled.', parse_mode: undefined });
    return { handled: true, answered: true, kind: 'alert_cancelled' };
  }

  if (action === 'ae' || action === 'ad') {
    const chainId = Number(p1);
    const address = validateEvmAddress(p2);
    if (!SUPPORTED_CHAINS.includes(chainId) || !address) {
      return invalidCallback(client, callbackQuery, 'Invalid alert target');
    }
    try {
      if (action === 'ae') {
        const chatId = callbackQuery.message?.chat?.id;
        if (chatId == null) return invalidCallback(client, callbackQuery);
        await alertsStore(ctx).createOrEnableAlert({ userId, chatId, chainId, address });
        await editCard(client, callbackQuery, {
          text: `*Alert enabled*\n\n${alertTarget(chainId, address)}\nRuntime changes, new indexed pool relationships, and indexed liquidity movement of 10% or more.`,
        });
        return { handled: true, answered: true, kind: 'alert_enabled' };
      }
      const disabled = await alertsStore(ctx).disableAlert({ userId, chainId, address });
      await editCard(client, callbackQuery, {
        text: disabled ? `*Alert disabled*\n\n${alertTarget(chainId, address)}` : 'That alert was already disabled.',
      });
      return { handled: true, answered: true, kind: 'alert_disabled' };
    } catch (error) {
      const text = error instanceof AlertStorageUnavailableError
        ? '*Alerts are temporarily unavailable*\n\nHook and token lookup still works.'
        : `*Alert not changed*\n\n${error instanceof Error ? error.message : 'Try again in a moment.'}`;
      await editCard(client, callbackQuery, { text });
      return { handled: true, answered: true, kind: 'alert_error' };
    }
  }

  if (action === 'hook') {
    const chainId = Number(p1);
    const hookAddress = validateEvmAddress(p2);
    if (!hookAddress) return invalidCallback(client, callbackQuery);
    const result = await hookMarkets(ctx, chainId, hookAddress);
    const relationships = result?.relationships || result?.markets || session?.siblings || [];
    const card = renderHookView(
      { address: session?.address || hookAddress, symbol: 'TOKEN', name: '' },
      chainId,
      { hookAddress, hookName: result?.project?.name || 'Hook', hookNamed: Boolean(result?.project) },
      relationships,
      0
    );
    setSession(userId, { chainId, address: session?.address || hookAddress, hookAddress, siblings: relationships });
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: 'hook' };
  }

  if (action === 'siblings') {
    const chainId = Number(p1);
    const hookAddress = validateEvmAddress(p2);
    const offset = Math.max(0, Number(p3) || 0);
    if (!hookAddress) return invalidCallback(client, callbackQuery);
    const result = await hookMarkets(ctx, chainId, hookAddress);
    const relationships = result?.relationships || result?.markets || session?.siblings || [];
    const card = renderHookView(
      { address: session?.address || hookAddress, symbol: 'TOKEN', name: '' },
      chainId,
      { hookAddress, hookName: result?.project?.name || 'Hook', hookNamed: Boolean(result?.project) },
      relationships,
      offset
    );
    setSession(userId, { chainId, address: session?.address || hookAddress, hookAddress, siblings: relationships });
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: 'siblings' };
  }

  if (action === 'sibling' || action === 'refresh') {
    const chainId = Number(p1);
    const address = validateEvmAddress(p2);
    if (!address) return invalidCallback(client, callbackQuery);
    const relationships = await tokenRelationships(ctx, address);
    const relation = relationships.find((item) => Number(item.chainId) === chainId) || relationships[0];
    if (!relation) return invalidCallback(client, callbackQuery, 'No relationship found');
    const token = tokenFromRelationship(address, relation);
    const hookInfo = relation.hookAddress
      ? { hookAddress: relation.hookAddress, hookName: relation.hookName || 'Hook', hookNamed: Boolean(relation.hookName) }
      : null;
    const card = renderTokenCard(token, relation.chainId, hookInfo, relationships.map(marketFromRelationship));
    setSession(userId, sessionForRelationship(address, relation, relationships));
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: action };
  }

  if (action === 'buy' || action === 'sell') {
    const chainId = Number(p1);
    const address = validateEvmAddress(p2);
    if (!address) return invalidCallback(client, callbackQuery);
    const card = renderPresetGrid(chainId, { address, symbol: 'TOKEN', name: '' }, action);
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: 'preset_grid', side: action };
  }

  if (action === 'bp' || action === 'sp') {
    const chainId = Number(p1);
    const address = validateEvmAddress(p2);
    const notional = Math.max(1, Math.min(100_000, Number(p3) || 100));
    if (!address) return invalidCallback(client, callbackQuery);
    const readiness = { ready: false, reason: 'user-owned wallet signing is not connected' };
    const { message, receipt } = renderTradePreview(
      chainId,
      action === 'bp' ? 'buy' : 'sell',
      notional,
      { address, symbol: 'TOKEN', name: '' },
      readiness
    );
    await editCard(client, callbackQuery, message);
    return { handled: true, answered: true, kind: 'preview', receipt };
  }

  if (action === 'back') {
    await client.answer(callbackQuery.id, { text: 'Paste an address for a fresh view' });
    return { handled: true, answered: true, kind: 'back' };
  }

  return invalidCallback(client, callbackQuery);
}

async function invalidCallback(client, callbackQuery, text = 'That action expired') {
  await client.answer(callbackQuery.id, { text, show_alert: true });
  return { handled: true, answered: true, reason: 'invalid_callback' };
}

export { verifyWebhookSecret } from './bot-api.js';

export function handleTelegramUpdate(update, env, services = {}) {
  return handleUpdate(update, { env, services });
}
