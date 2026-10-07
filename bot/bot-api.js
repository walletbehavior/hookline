// ----------------------------------------------------------------------------
// bot/bot-api.js — Telegram Bot API client and webhook handling
//
// The bot speaks the Telegram Bot API (https://core.telegram.org/bot-api).
//
// Two deployment modes:
//   1. Webhook server (Node): run `node bot/index.js webhook` which calls
//      setWebhook against the Bot API, then listens for incoming updates.
//      The webhook URL must be publicly reachable (use `node bot/index.js
//      webhook --host 127.0.0.1 --port 3000` for local testing, registering
//      the HTTP URL with BotFather).
//   2. Cloudflare Worker route: POST /tg/webhook in worker/index.js forwards
//      Telegram updates to bot/index.js.handleUpdate(). The worker route
//      "uses the existing Cloudflare Worker" while keeping the public website
//      and current routes untouched.
//
// Secret verification: the webhook URL is registered with a secret_token that
// Telegram echoes as X-Telegram-Bot-Api-Secret-Token in the request header.
// bot-api.js verifies this header against TELEGRAM_BOT_SECRET_TOKEN (derived
// from the bot token via setWebhook secret_token) before processing.
//
// SECURITY: no seed phrase / private key is ever requested or logged. Any
// message containing secret-like tokens is rejected with a safe message and
// nothing is retained. See bot/receipts.js FORBIDDEN_SECRET_KEY_RE.
// ----------------------------------------------------------------------------
'use strict';

const API_BASE = 'https://api.telegram.org';
const TG_UPDATE_RE = /^update_id\d+$/;

export class TelegramApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class TelegramClient {
  constructor(botToken) {
    if (!botToken || !/^[\d]+:[A-Za-z0-9_-]{14,255}$/.test(botToken)) {
      throw new Error('invalid telegram bot token');
    }
    this.botToken = botToken;
    this.botId = null;
    this.botUsername = null;
  }

  url(path) {
    return `${API_BASE}/bot${this.botToken}${path}`;
  }

  async request(path, body = {}, method = 'POST') {
    const url = this.url(path);
    const headers = { 'Content-Type': 'application/json' };
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    let json;
    try {
      json = await response.json().catch(() => ({}));
    } catch {
      throw new TelegramApiError(`Bot API responded with non-JSON (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      const message = json.description || json.error_message || `HTTP ${response.status}`;
      throw new TelegramApiError(message, response.status);
    }
    if (!json.ok) {
      throw new TelegramApiError(json.description || 'Bot API returned ok=false', response.status);
    }
    return json.result;
  }

  async getMe() {
    this.botId = null;
    const me = await this.request('/getMe');
    this.botId = me.id;
    this.botUsername = me.username;
    return me;
  }

  async verifyToken(botToken) {
    const client = new TelegramClient(botToken);
    const me = await client.getMe();
    return { ok: true, botId: me.id, botUsername: me.username };
  }

  async setWebhook(url, secretToken) {
    await this.request('/setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async deleteWebhook() {
    await this.request('/deleteWebhook', { delete_pending_updates: true });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.request('/sendMessage', { chat_id: chatId, text, ...options });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.request('/answerCallbackQuery', { callback_query_id: callbackQueryId, ...options });
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return this.request('/editMessageText', {
      chat_id: chatId, message_id: messageId, text, ...options,
    });
  }

  async getUpdates(offset = 0, limit = 100) {
    return this.request('/getUpdates', { offset, limit }, 'GET');
  }
}

/** Verify the Telegram webhook secret header. */
export function verifyWebhookSecret(request, expectedSecret) {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!header) {
    // The secret token Telegram sends is absent: treat as missing so both
    // mis-configuration and forged requests are rejected explicitly.
    return { ok: false, reason: 'webhook_secret_missing' };
  }
  if (!expectedSecret) {
    // No secret configured: reject so the deployment is auditable.
    return { ok: false, reason: 'webhook_secret_missing' };
  }
  if (header !== expectedSecret) {
    return { ok: false, reason: 'webhook_secret_mismatch', header, expected: '***'.repeat(4) };
  }
  return { ok: true };
}

/** Parse a Telegram update into a normalized event. */
export function parseUpdate(update) {
  if (!update || typeof update.update_id !== 'number') {
    return { valid: false, reason: 'not_a_telegram_update' };
  }
  if (update.message) {
    return { valid: true, kind: 'message', update, message: update.message };
  }
  if (update.callback_query) {
    return { valid: true, kind: 'callback_query', update, callback_query: update.callback_query };
  }
  return { valid: false, reason: 'unknown_update_type', type: 'other' };
}

/** Parse an incoming message into a command / address lookup. */
export function parseMessage(message) {
  const chatId = message.chat?.id;
  const fromId = message.from?.id;
  const text = typeof message.text === 'string' ? message.text : '';
  const entities = Array.isArray(message.entities) ? message.entities : [];

  // Telegram supplies a bot_command entity, but accepting a leading slash also
  // makes forwarded commands and deterministic tests behave consistently.
  if (text.startsWith('/') && (!entities.length || entities[0].type === 'bot_command')) {
    const parts = text.slice(1).split(/\s+/);
    return { kind: 'command', command: parts[0], args: parts.slice(1).join(' '), chatId, fromId, entities, text };
  }

  // Pasted EVM contract address (standalone lookups only, to avoid false
  // positives on normal chat).
  const fullMatch = text.trim().match(/^0x[0-9a-fA-F]{40}$/i);
  if (fullMatch && !entities.some((e) => e.type === 'bot_command' || e.type === 'text_link')) {
    return { kind: 'evm_contract_lookup', address: fullMatch[0].toLowerCase(), chatId, fromId, text };
  }

  return { kind: 'unknown', chatId, fromId, text };
}
