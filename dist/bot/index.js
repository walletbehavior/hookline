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
import { renderTokenCard } from './token-view.js';
import { renderHookView } from './hook-view.js';
import { handleProjectMessage, handleProjectCallback, projectAlertSubscriptions } from '../projects/telegram.js';
import { MAIN_MENU, navigationRows, alertNavigationRows, menuButton, privateConversation, cleanLabel,alertHtml } from './navigation.js';
import { alertIdentities } from './alert-identity.js';
import { renderTradingSettings,settingsInputPrompt,saveSettingsInput,saveSettingsPreset,renderTradeHandoff,validateTradeInput,EXECUTION_CHAINS } from './trading-settings.js';
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
    try {
      await client.edit(chatId, messageId, card.text, {
        parse_mode: card.parse_mode === null ? undefined : card.parse_mode || 'Markdown',
        reply_markup: card.reply_markup,
        disable_web_page_preview: true,
      });
    } catch (error) { if (!/message is not modified/i.test(error?.message || '')) throw error; }
  }
  await client.answer(callbackQuery.id);
}

export async function handleUpdate(update, ctx = {}) {
  const event = parseUpdate(update);
  if (!event.valid) return { handled: false, reason: event.reason };
  const userId = String(ctx.userIdResolver ? ctx.userIdResolver(update) : sessionKey(update));
  if (event.kind === 'message') return handleMessage(event.message, ctx, userId);
  if (event.kind === 'callback_query') {
    const client=makeClient(ctx.env);
    if(!client) return {handled:false,reason:'telegram_not_configured'};
    if(!privateConversation(event.callback_query.message?.chat?.id,userId,event.callback_query.from?.id)) return invalidCallback(client,event.callback_query,'Open Hookline in your own private chat to use these buttons.');
    if(/^(pr:|project_follow:)/.test(String(event.callback_query.data || ''))) setSession(userId,{...getSession(userId),pendingInput:null});
    const projectResult=await handleProjectCallback(client,event.callback_query,ctx,userId);
    return projectResult || handleCallback(event.callback_query, ctx, userId);
  }
  return { handled: false, reason: 'unsupported_update' };
}

async function handleMessage(message, ctx, userId) {
  const client = makeClient(ctx.env);
  if (!client) return { handled: false, reason: 'telegram_not_configured' };
  const parsed = parseMessage(message);
  const pendingInput=getSession(userId)?.pendingInput;
  if(parsed.kind!=='command' && pendingInput?.expiresAt>Date.now() && privateConversation(parsed.chatId,userId,parsed.fromId)) {
    if(pendingInput.kind==='setting') {
      try {
        await saveSettingsInput(ctx,userId,parsed.chatId,pendingInput.field,parsed.text);
        setSession(userId,{...getSession(userId),pendingInput:null});
        const section=pendingInput.field==='profile'?'profiles':pendingInput.field;
        return settingsCommand(client,parsed,ctx,userId,section,'Settings saved.');
      } catch(error) {
        const reply=await client.reply(parsed.chatId,error?.message || 'That setting could not be saved.',{reply_markup:{inline_keyboard:[[menuButton('Back to settings','settings')],...navigationRows()]}});
        return {handled:true,messageId:reply?.message_id};
      }
    }
    if(pendingInput.kind==='trade_amount') {
      try {
        const input=validateTradeInput(pendingInput.side,parsed.text);
        const card=await renderTradeHandoff(ctx,userId,parsed.chatId,{chainId:pendingInput.chainId,address:pendingInput.address,side:pendingInput.side,...input});
        setSession(userId,{...getSession(userId),pendingInput:null});
        const reply=await client.reply(parsed.chatId,card.text,{reply_markup:card.reply_markup,disable_web_page_preview:true});
        return {handled:true,messageId:reply?.message_id,kind:'trade_handoff'};
      } catch(error) {
        const reply=await client.reply(parsed.chatId,error?.message || 'Enter a valid amount.',{reply_markup:{inline_keyboard:navigationRows()}});
        return {handled:true,messageId:reply?.message_id};
      }
    }
  }

  if (parsed.kind === 'command') {
    setSession(userId,{...getSession(userId),pendingInput:null});
    const projectResult=await handleProjectMessage(client,{...parsed,messageId:message.message_id},ctx,userId);
    if(projectResult) return projectResult;
    const command = parsed.command.toLowerCase().split('@')[0];
    if (command === 'start') return startCommand(client, parsed, ctx, userId);
    if (command === 'help') return helpCommand(client, parsed);
    if (command === 'about' || command === 'fees') return aboutCommand(client, parsed);
    if (command === 'alerts' || command === 'alert') return alertsCommand(client, parsed, ctx, userId);
    if (command === 'wallet') return walletCommand(client, parsed);
    if (command === 'positions') return positionsCommand(client, parsed);
    if (command === 'settings') return settingsCommand(client, parsed,ctx,userId);
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
    const pending=getSession(userId)?.pendingInput;
    if (pending?.kind==='alert_address' && pending.expiresAt>Date.now() && privateConversation(parsed.chatId,userId,parsed.fromId)) {
      setSession(userId,{...getSession(userId),pendingInput:null});
      return alertAddressLookup(client,ctx,parsed.chatId,userId,parsed.address);
    }
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
  setSession(userId,{...getSession(userId),pendingInput:null});
  const text = [
    '🪝 *Hookline*',
    '',
    'Paste a token or hook address. I\'ll map the token, its hook, related pools and sibling tokens.',
    '',
    'Use the buttons to discover projects, follow changes, manage alerts, and open wallet-reviewed trades.',
    '',
    'Never send a seed phrase or private key here.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: MAIN_MENU },
  });
  return { handled: true, messageId: reply?.message_id };
}

async function helpCommand(client, parsed) {
  const text = [
    '*Use Hookline in Telegram*',
    '',
    'Paste an EVM address to look it up. Projects opens the ecosystem directory. My alerts shows named subscriptions with pause and resume controls.',
    'Tap Hook for contract details, Related tokens for sibling markets, or Open trade to review a real route on the website.',
    '',
    'Data comes from Hookline\'s hook index, v4.xyz and DexScreener.',
    'Telegram does not sign. Reviewed execution opens on hookline.world, where your own wallet signs and submits.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: MAIN_MENU } });
  return { handled: true, messageId: reply?.message_id };
}

async function aboutCommand(client, parsed) {
  const text = [
    '*About Hookline*',
    '',
    'Hookline maps tokens, hooks, pools and sibling markets across chains.',
    '',
    '*Trading fees*',
    'Gross execution fee: 1% of trade notional',
    'Instant cashback: 0.3% of trade notional',
    'Effective fee: 0.7% of trade notional',
    '',
    'Reviewed routes open on hookline.world. Your connected wallet signs and submits; Hookline never receives wallet secrets.',
  ].join('\n');
  const reply = await client.reply(parsed.chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: navigationRows() } });
  return { handled: true, messageId: reply?.message_id };
}

async function promptForAddress(client, chatId, command) {
  const reply = await client.reply(chatId, 'Paste the token or hook address in this chat. Never send a private key or seed phrase.', { reply_markup: { inline_keyboard: navigationRows() } });
  return { handled: true, found: false, messageId: reply?.message_id };
}

function alertsStore(ctx) {
  return ctx.services?.alerts || makeD1AlertStore(ctx.env);
}

async function alertsCommand(client, parsed, ctx, userId) {
  if (!privateConversation(parsed.chatId,userId,parsed.fromId ?? userId)) {
    const reply=await client.reply(parsed.chatId,'Open Hookline in your private chat to see or change alerts.',{reply_markup:{inline_keyboard:[[{text:'Open private bot',url:'https://t.me/HooklineTradeBot'}]]}});
    return {handled:true,messageId:reply?.message_id,reason:'private_chat_required'};
  }
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
    const row={chain_id:chainId,target_address:address,target_type:'hook'};
    const identity=(await alertIdentities(ctx,[row])).get(row);
    const reply = await client.reply(parsed.chatId, alertHtml([
      'Enable hook alert?', '', identity.name, `${CHAIN_CONFIG[chainId]?.name || chainId} · Hook changes`, {address},
      '', 'Checks every 10 minutes for runtime changes and indexed market changes. A hook alert covers its related markets, not a token-price threshold.',
    ]), {parse_mode:'HTML',reply_markup:{inline_keyboard:[[
      {text:'Enable alert',callback_data:`tg:ae:${chainId}:${address}`},
      menuButton('Cancel','alerts'),
    ],[{text:'Contract details',url:`https://hookline.world/#/board/${chainId}/${address}`}],...alertNavigationRows()]}});
    return { handled: true, messageId: reply?.message_id };
  }

  try {
    const [list,projectFollows,projects]=await Promise.all([
      alertsStore(ctx).listUserAlerts(userId,{includePaused:true}),
      projectAlertSubscriptions(ctx,userId,parsed.chatId),
      Promise.resolve().then(()=>ctx.services?.projects?.listProjects?.() || []).catch(()=>[]),
    ]);
    const safeList=list.filter(row=>String(row.telegram_user_id)===String(userId) && String(row.chat_id)===String(parsed.chatId));
    const entries=[...projectFollows.map(follow=>({kind:'project',follow,project:projects.find(p=>p.id===follow.project_id)})),...safeList.map(alert=>({kind:'contract',alert}))];
    const offset=Math.max(0,Math.min(Math.max(entries.length-1,0),Number.parseInt(args,10)||0));
    const page=entries.slice(offset,offset+5);
    const identities=await alertIdentities(ctx,page.filter(entry=>entry.alert).map(entry=>entry.alert),projects);
    const active=safeList.filter(alert=>Number(alert.enabled)===1).length;
    const lines=['Your alerts',''];
    const keyboard=[];
    if(!entries.length) lines.push('Nothing followed yet. Add a hook alert or choose a project to follow.');
    for(const entry of page) {
      if(entry.kind==='project') {
        const {follow,project}=entry;
        const enabled=Number(follow.enabled)===1,name=cleanLabel(project?.name || follow.project_id);
        const chains=[...new Set((project?.deployments || []).map(d=>CHAIN_CONFIG[d.chainId]?.name || `Chain ${d.chainId}`))];
        lines.push(`${name}`,`Project · ${enabled?'Active':'Paused'}${chains.length?` · ${chains.join(', ')}`:''}`,'Observed configuration changes and retained contract events.','');
        keyboard.push([{text:`Details · ${name.slice(0,30)}`,callback_data:`pr:view:${follow.project_id}`},{text:enabled?'Pause':'Resume',callback_data:`pr:${enabled?'off':'on'}:${follow.project_id}`}]);
      } else {
        const alert=entry.alert,identity=identities.get(alert),enabled=Number(alert.enabled)===1;
        lines.push(identity.name,`${CHAIN_CONFIG[Number(alert.chain_id)]?.name || `Chain ${alert.chain_id}`} · ${identity.kind==='token'?'Token':'Hook'} · ${enabled?'Active':'Paused'}`,{address:alert.target_address},identity.source,'');
        keyboard.push([{text:`Details · ${identity.name.slice(0,30)}`,callback_data:`tg:av:${alert.chain_id}:${alert.target_address}`},{text:enabled?'Pause':'Resume',callback_data:`tg:${enabled?'ad':'ae'}:${alert.chain_id}:${alert.target_address}`}]);
      }
    }
    if(entries.length) lines.push(`${active} of ${MAX_ALERTS_PER_USER} hook alert slots used. ${projectFollows.filter(row=>Number(row.enabled)===1).length} projects followed.`);
    const paging=[];
    if(offset>0) paging.push({text:'Previous alerts',callback_data:`tg:al:${Math.max(0,offset-5)}`});
    if(offset+5<entries.length) paging.push({text:'More alerts',callback_data:`tg:al:${offset+5}`});
    if(paging.length) keyboard.push(paging);
    keyboard.push(...alertNavigationRows());
    const reply = await client.reply(parsed.chatId, alertHtml(lines), {parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard},disable_web_page_preview:true});
    return { handled: true, messageId: reply?.message_id };
  } catch (error) {
    const unavailable = error instanceof AlertStorageUnavailableError;
    const reply = await client.reply(
      parsed.chatId,
      unavailable
        ? '*Alerts are temporarily unavailable*\n\nHook and token lookup still works.'
        : '*Alerts could not load*\n\nTry again in a moment.',
      { parse_mode: 'Markdown',reply_markup:{inline_keyboard:alertNavigationRows()} },
    );
    return { handled: true, messageId: reply?.message_id };
  }
}

async function addAlertMenu(client,parsed,ctx,userId) {
  if(!privateConversation(parsed.chatId,userId)) return alertsCommand(client,parsed,ctx,userId);
  setSession(userId,{...getSession(userId),pendingInput:{kind:'alert_address',expiresAt:Date.now()+10*60*1000}});
  const reply=await client.reply(parsed.chatId,'Add an alert\n\nPaste a hook or token address. For a token, choose one of its linked hooks. Or tap Projects to follow an entire project.\n\nNever send a private key or seed phrase.',{reply_markup:{inline_keyboard:[[menuButton('Choose a project','projects'),{text:'Browse hooks',url:'https://hookline.world/#/board'}],...navigationRows()]}});
  return {handled:true,messageId:reply?.message_id};
}

async function alertAddressLookup(client,ctx,chatId,userId,address) {
  const relationships=await tokenRelationships(ctx,address);
  const unique=new Map();
  for(const relation of relationships) {
    const hookAddress=validateEvmAddress(relation.hookAddress);
    if(!hookAddress || !SUPPORTED_CHAINS.includes(Number(relation.chainId))) continue;
    const key=`${relation.chainId}:${hookAddress}`;
    if(!unique.has(key)) unique.set(key,{...relation,hookAddress});
  }
  const keyboard=[];
  let text;
  if(unique.size) {
    const sample=[...unique.values()][0],token=tokenFromRelationship(address,sample);
    text=alertHtml([`Follow ${cleanLabel(token.symbol || token.name || 'this token')}’s hook`,'','Choose a linked hook. These alerts track hook and indexed market changes, not token-price thresholds.',{address}]);
    for(const relation of [...unique.values()].slice(0,8)) keyboard.push([{text:`${cleanLabel(relation.hookName || 'Unnamed hook',28)} · ${CHAIN_CONFIG[relation.chainId]?.code || relation.chainId}`,callback_data:`tg:as:${relation.chainId}:${relation.hookAddress}`}]);
  } else {
    text=alertHtml(['Choose the hook’s chain','',{address},'','No token relationship was indexed for this address. Select its chain to review a hook alert.']);
    for(const chainId of SUPPORTED_CHAINS) keyboard.push([{text:CHAIN_CONFIG[chainId].name,callback_data:`tg:as:${chainId}:${address}`}]);
  }
  keyboard.push(...navigationRows());
  const reply=await client.reply(chatId,text,{parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard}});
  return {handled:true,messageId:reply?.message_id};
}

async function walletCommand(client, parsed) {
  const reply = await client.reply(
    parsed.chatId,
    '*User-owned wallet*\n\nOpen a reviewed route on hookline.world and connect your EVM wallet. Your wallet signs and submits. Telegram never receives a private key, seed phrase, or signing session.',
    { parse_mode: 'Markdown',reply_markup:{inline_keyboard:[[{text:'Connect on Hookline',url:'https://hookline.world/#/board'}],...navigationRows()]} }
  );
  return { handled: true, messageId: reply?.message_id };
}

async function positionsCommand(client, parsed) {
  const reply = await client.reply(
    parsed.chatId,
    '*Positions*\n\nPosition tracking activates with wallet connection. No wallet is connected to this Telegram account yet.',
    { parse_mode: 'Markdown',reply_markup:{inline_keyboard:navigationRows()} }
  );
  return { handled: true, messageId: reply?.message_id };
}

async function settingsCommand(client, parsed,ctx,userId,section='main',notice='') {
  if(!privateConversation(parsed.chatId,userId,parsed.fromId ?? userId)) return alertsCommand(client,parsed,ctx,userId);
  const card=await renderTradingSettings(ctx,userId,parsed.chatId,section,notice);
  const reply=await client.reply(parsed.chatId,card.text,{reply_markup:card.reply_markup,disable_web_page_preview:true});
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
  // Every button leaves the previous input prompt. Only an explicit Custom
  // action below may arm a new prompt, so stale messages cannot change settings.
  const session = {...getSession(userId),pendingInput:null};
  setSession(userId,session);

  const editReplyClient={...client,reply:async(chatId,text,options={})=>{
    try {await client.edit(chatId,callbackQuery.message.message_id,text,{...options,disable_web_page_preview:true});}
    catch(error) {if(!/message is not modified/i.test(error?.message || '')) throw error;}
    return {message_id:callbackQuery.message.message_id};
  }};
  const menuParsed={chatId:callbackQuery.message.chat.id,fromId:callbackQuery.from.id,args:''};
  if(action==='menu' || action==='back' || action==='al' || action==='as') {
    setSession(userId,{...session,pendingInput:null});
    let result;
    const menu=action==='back'?'main':p1;
    if(action==='al') result=await alertsCommand(editReplyClient,{...menuParsed,args:p1},ctx,userId);
    else if(action==='as') {
      const address=validateEvmAddress(p2),chainId=Number(p1);
      if(!address || !SUPPORTED_CHAINS.includes(chainId)) return invalidCallback(client,callbackQuery,'Invalid alert target');
      result=await alertsCommand(editReplyClient,{...menuParsed,args:`${chainId}:${address}`},ctx,userId);
    } else if(menu==='main') {
      setSession(userId,{...session,pendingInput:null});
      result=await startCommand(editReplyClient,menuParsed,ctx,userId);
    } else if(menu==='alerts') result=await alertsCommand(editReplyClient,menuParsed,ctx,userId);
    else if(menu==='add') result=await addAlertMenu(editReplyClient,menuParsed,ctx,userId);
    else if(menu==='projects') result=await handleProjectMessage(editReplyClient,{...menuParsed,command:'projects'},ctx,userId);
    else if(menu==='lookup') {
      setSession(userId,{...session,pendingInput:null});
      result=await promptForAddress(editReplyClient,menuParsed.chatId,'');
    } else if(menu==='wallet') result=await walletCommand(editReplyClient,menuParsed);
    else if(menu==='settings') {
      setSession(userId,{...session,pendingInput:null});
      result=await settingsCommand(editReplyClient,menuParsed,ctx,userId);
    }
    else if(menu==='help') result=await helpCommand(editReplyClient,menuParsed);
    else if(menu==='about') result=await aboutCommand(editReplyClient,menuParsed);
    else return invalidCallback(client,callbackQuery,'Unknown menu');
    await client.answer(callbackQuery.id);
    return {...result,handled:true,answered:true,kind:'menu'};
  }

  if(action==='settings') {
    setSession(userId,{...session,pendingInput:null});
    const card=await renderTradingSettings(ctx,userId,menuParsed.chatId,p1 || 'main');
    await editCard(client,callbackQuery,card);
    return {handled:true,answered:true,kind:'settings'};
  }
  if(action==='pref') {
    if(p1==='custom') {
      const prompt=settingsInputPrompt(p2);
      if(!prompt) return invalidCallback(client,callbackQuery,'Invalid setting');
      setSession(userId,{...session,pendingInput:{kind:'setting',field:p2,expiresAt:Date.now()+10*60*1000}});
      await editCard(client,callbackQuery,{text:`Custom setting\n\n${prompt}\n\nNever send wallet keys or seed phrases.`,parse_mode:null,reply_markup:{inline_keyboard:[[menuButton('Cancel','settings')],...navigationRows()]}});
    } else {
      try {
        await saveSettingsPreset(ctx,userId,menuParsed.chatId,p1,p2);
        await editCard(client,callbackQuery,await renderTradingSettings(ctx,userId,menuParsed.chatId,p1==='profile'?'profiles':p1,'Settings saved.'));
      } catch(error) {await editCard(client,callbackQuery,{text:error?.message || 'Setting could not be saved.',parse_mode:null,reply_markup:{inline_keyboard:[[menuButton('Back to settings','settings')],...navigationRows()]}});}
    }
    return {handled:true,answered:true,kind:'settings'};
  }
  if(action==='custombuy' || action==='customsell') {
    const chainId=Number(p1),address=validateEvmAddress(p2),side=action==='customsell'?'sell':'buy';
    if(!address || !EXECUTION_CHAINS.has(chainId)) return invalidCallback(client,callbackQuery,'Unsupported trade target');
    setSession(userId,{...session,pendingInput:{kind:'trade_amount',chainId,address,side,expiresAt:Date.now()+10*60*1000}});
    await editCard(client,callbackQuery,{text:side==='sell'?'Custom sell\n\nSend a whole percentage from 1 to 100. The website checks the connected wallet’s balance before a fresh quote.':`Custom buy\n\nSend an amount in ${chainId===56?'BNB':'ETH'}, such as 0.05. If this market uses a different input asset, the website stops for review. Nothing is signed in this chat.`,parse_mode:null,reply_markup:{inline_keyboard:navigationRows()}});
    return {handled:true,answered:true,kind:'trade_input'};
  }

  if(action==='av') {
    const chainId=Number(p1),address=validateEvmAddress(p2);
    if(!address || !SUPPORTED_CHAINS.includes(chainId)) return invalidCallback(client,callbackQuery,'Invalid alert');
    try {
      const rows=await alertsStore(ctx).listUserAlerts(userId,{includePaused:true});
      const row=rows.find(alert=>String(alert.telegram_user_id)===userId && String(alert.chat_id)===String(menuParsed.chatId) && Number(alert.chain_id)===chainId && alert.target_address.toLowerCase()===address);
      if(!row) return invalidCallback(client,callbackQuery,'That alert is not in your private account.');
      const identity=(await alertIdentities(ctx,[row])).get(row),enabled=Number(row.enabled)===1;
      await editCard(client,callbackQuery,{parse_mode:'HTML',text:alertHtml([identity.name,`${CHAIN_CONFIG[chainId]?.name || chainId} · ${identity.kind==='token'?'Token':'Hook'} alert · ${enabled?'Active':'Paused'}`,{address},'',identity.source,row.last_checked_at?`Last checked: ${new Date(Number(row.last_checked_at)).toISOString()}`:'Awaiting the first check.','Runtime and indexed market changes. Index coverage is not exhaustive.']),reply_markup:{inline_keyboard:[[{text:'Open details',url:`https://hookline.world/#/board/${chainId}/${address}`},{text:enabled?'Pause alert':'Resume alert',callback_data:`tg:${enabled?'ad':'ae'}:${chainId}:${address}`}],...alertNavigationRows()]} });
      return {handled:true,answered:true,kind:'alert_details'};
    } catch {return invalidCallback(client,callbackQuery,'Alert details are temporarily unavailable.');}
  }

  if (action === 'ac') {
    await editCard(client, callbackQuery, { text: 'Alert setup cancelled.', parse_mode: null,reply_markup:{inline_keyboard:alertNavigationRows()} });
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
        const row={chain_id:chainId,target_address:address,target_type:'hook'};
        const identity=(await alertIdentities(ctx,[row])).get(row);
        await editCard(client, callbackQuery, {
          parse_mode:'HTML',text:alertHtml(['Alert enabled','',identity.name,`${CHAIN_CONFIG[chainId]?.name || chainId} · Active`,{address},'Hook and indexed market changes']),
          reply_markup:{inline_keyboard:[[{text:'Details',callback_data:`tg:av:${chainId}:${address}`},{text:'Pause alert',callback_data:`tg:ad:${chainId}:${address}`}],...alertNavigationRows()]},
        });
        return { handled: true, answered: true, kind: 'alert_enabled' };
      }
      const ownedRows=await alertsStore(ctx).listUserAlerts(userId,{includePaused:true});
      if(!ownedRows.some(row=>String(row.telegram_user_id)===userId && String(row.chat_id)===String(callbackQuery.message.chat.id) && Number(row.chain_id)===chainId && row.target_address.toLowerCase()===address)) return invalidCallback(client,callbackQuery,'That alert is not saved in your private account.');
      await alertsStore(ctx).disableAlert({ userId,chatId:callbackQuery.message.chat.id, chainId, address });
      const row={chain_id:chainId,target_address:address,target_type:'hook'};
      const identity=(await alertIdentities(ctx,[row])).get(row);
      await editCard(client, callbackQuery, {
        parse_mode:'HTML',text:alertHtml(['Alert paused','',identity.name,`${CHAIN_CONFIG[chainId]?.name || chainId} · Paused`,{address},'Resume whenever you want.']),
        reply_markup:{inline_keyboard:[[{text:'Details',callback_data:`tg:av:${chainId}:${address}`},{text:'Resume alert',callback_data:`tg:ae:${chainId}:${address}`}],...alertNavigationRows()]},
      });
      return { handled: true, answered: true, kind: 'alert_disabled' };
    } catch (error) {
      const text = error instanceof AlertStorageUnavailableError
        ? 'Alerts are temporarily unavailable\n\nHook and token lookup still works.'
        : `Alert not changed\n\n${error instanceof Error ? error.message : 'Try again in a moment.'}`;
      await editCard(client, callbackQuery, { text,parse_mode:null,reply_markup:{inline_keyboard:alertNavigationRows()} });
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
      { hookAddress, hookName: result?.profile?.project?.name || result?.profile?.verifiedContract?.name || result?.project?.name || 'Unnamed hook', hookNamed: Boolean(result?.profile?.project || result?.profile?.verifiedContract || result?.project) },
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
      { hookAddress, hookName: result?.profile?.project?.name || result?.profile?.verifiedContract?.name || result?.project?.name || 'Unnamed hook', hookNamed: Boolean(result?.profile?.project || result?.profile?.verifiedContract || result?.project) },
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
    const card = await renderTradeHandoff(ctx,userId,menuParsed.chatId,{chainId,address,side:action});
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: 'trade_handoff', side: action };
  }

  if (action === 'bp' || action === 'sp') {
    const chainId = Number(p1);
    const address = validateEvmAddress(p2);
    if (!address) return invalidCallback(client, callbackQuery);
    const card=await renderTradeHandoff(ctx,userId,menuParsed.chatId,{chainId,address,side:action==='bp'?'buy':'sell',legacy:true});
    await editCard(client, callbackQuery, card);
    return { handled: true, answered: true, kind: 'trade_handoff' };
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
