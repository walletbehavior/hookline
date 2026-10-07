'use strict';
import { privateConversation } from './navigation.js';

export const MAX_ALERTS_PER_USER = 10;
export const MAX_ALERTS_GLOBAL = 500;
export const MAX_SAVED_ALERTS_PER_USER = 40;
export const ALERT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export class AlertStorageUnavailableError extends Error {
  constructor() {
    super('Alert storage is unavailable');
    this.name = 'AlertStorageUnavailableError';
  }
}

function requireDb(env) {
  if (!env?.DB) throw new AlertStorageUnavailableError();
  return env.DB;
}

function normalizedAddress(value) {
  return String(value || '').toLowerCase();
}

async function countActive(db, userId = null) {
  const statement = userId == null
    ? db.prepare('SELECT COUNT(*) AS count FROM alerts WHERE enabled = 1')
    : db.prepare('SELECT COUNT(*) AS count FROM alerts WHERE telegram_user_id = ? AND enabled = 1').bind(String(userId));
  const row = await statement.first();
  return Number(row?.count || 0);
}

export function makeD1AlertStore(env) {
  const db = requireDb(env);

  return {
    async listUserAlerts(userId, { includePaused = false } = {}) {
      if (!privateConversation(userId, userId)) throw new Error('Open Hookline in a private chat to manage alerts.');
      const result = await db.prepare(
        `SELECT id, telegram_user_id, chat_id, target_type, chain_id, target_address,
                rule, enabled, baseline_json, next_check_at, last_checked_at,
                created_at, updated_at
           FROM alerts
          WHERE telegram_user_id = ? AND chat_id = ? ${includePaused ? '' : 'AND enabled = 1'}
          ORDER BY enabled DESC, created_at ASC
          LIMIT ?`,
      ).bind(String(userId), String(userId), includePaused ? MAX_SAVED_ALERTS_PER_USER : MAX_ALERTS_PER_USER).all();
      return result.results || [];
    },

    async createOrEnableAlert({ userId, chatId, chainId, address, now = Date.now() }) {
      if (!privateConversation(chatId, userId)) throw new Error('Open Hookline in a private chat to manage alerts.');
      const targetAddress = normalizedAddress(address);
      const existing = await db.prepare(
        `SELECT id, enabled FROM alerts
          WHERE telegram_user_id = ? AND chat_id = ? AND chain_id = ? AND target_address = ?
          LIMIT 1`,
      ).bind(String(userId), String(chatId), Number(chainId), targetAddress).first();

      if (existing?.enabled) return { id: Number(existing.id), enabled: true, created: false, unchanged: true };

      if (await countActive(db, userId) >= MAX_ALERTS_PER_USER) {
        const error = new Error(`You can track up to ${MAX_ALERTS_PER_USER} hooks at once.`);
        error.code = 'USER_ALERT_LIMIT';
        throw error;
      }
      if (await countActive(db) >= MAX_ALERTS_GLOBAL) {
        const error = new Error('Hookline alerts are at capacity right now.');
        error.code = 'GLOBAL_ALERT_LIMIT';
        throw error;
      }

      if (existing) {
        const resumed = await db.prepare(
          `UPDATE alerts SET enabled = 1, next_check_at = ?, updated_at = ?
            WHERE id = ? AND telegram_user_id = ? AND chat_id = ? AND enabled = 0
              AND (SELECT COUNT(*) FROM alerts WHERE telegram_user_id = ? AND enabled = 1) < ?
              AND (SELECT COUNT(*) FROM alerts WHERE enabled = 1) < ?`,
        ).bind(now, now, Number(existing.id), String(userId), String(chatId), String(userId), MAX_ALERTS_PER_USER, MAX_ALERTS_GLOBAL).run();
        if (!Number(resumed.meta?.changes || 0)) throw new Error('Alert capacity changed. Refresh your alerts and try again.');
        return { id: Number(existing.id), enabled: true, created: false };
      }

      const inserted = await db.prepare(
        `INSERT INTO alerts
          (telegram_user_id, chat_id, target_type, chain_id, target_address, rule,
           enabled, baseline_json, next_check_at, last_checked_at, created_at, updated_at)
         SELECT ?, ?, 'hook', ?, ?, 'hook_activity', 1, NULL, ?, NULL, ?, ?
           WHERE (SELECT COUNT(*) FROM alerts WHERE telegram_user_id = ? AND enabled = 1) < ?
             AND (SELECT COUNT(*) FROM alerts WHERE enabled = 1) < ?
             AND (SELECT COUNT(*) FROM alerts WHERE telegram_user_id = ?) < ?
         ON CONFLICT(telegram_user_id,chat_id,chain_id,target_address) DO NOTHING`,
      ).bind(String(userId), String(chatId), Number(chainId), targetAddress, now, now, now, String(userId), MAX_ALERTS_PER_USER, MAX_ALERTS_GLOBAL, String(userId), MAX_SAVED_ALERTS_PER_USER).run();
      if (!Number(inserted.meta?.changes || 0)) {
        const duplicate = await db.prepare('SELECT id,enabled FROM alerts WHERE telegram_user_id=? AND chat_id=? AND chain_id=? AND target_address=?').bind(String(userId), String(chatId), Number(chainId), targetAddress).first();
        if (duplicate?.enabled) return { id: Number(duplicate.id), enabled: true, created: false, unchanged: true };
        throw new Error('Alert capacity reached. Pause an active alert or use an existing saved alert.');
      }
      return { id: Number(inserted.meta?.last_row_id || 0), enabled: true, created: true };
    },

    async disableAlert({ userId, chatId = userId, chainId, address, now = Date.now() }) {
      if (!privateConversation(chatId, userId)) throw new Error('Open Hookline in a private chat to manage alerts.');
      const result = await db.prepare(
        `UPDATE alerts
            SET enabled = 0, updated_at = ?
          WHERE telegram_user_id = ? AND chat_id = ? AND chain_id = ? AND target_address = ? AND enabled = 1`,
      ).bind(now, String(userId), String(chatId), Number(chainId), normalizedAddress(address)).run();
      return Number(result.meta?.changes || 0) > 0;
    },

    async listDueAlerts({ now = Date.now(), limit = 25, perUserLimit = 10 }) {
      const fetchLimit = Math.min(MAX_ALERTS_GLOBAL, Math.max(limit, limit * perUserLimit));
      const result = await db.prepare(
        `SELECT id, telegram_user_id, chat_id, target_type, chain_id, target_address,
                rule, enabled, baseline_json, next_check_at, last_checked_at
           FROM alerts
          WHERE enabled = 1 AND next_check_at <= ?
          ORDER BY next_check_at ASC
          LIMIT ?`,
      ).bind(now, fetchLimit).all();
      const counts = new Map();
      const due = [];
      for (const row of result.results || []) {
        const userId = String(row.telegram_user_id);
        if (!privateConversation(row.chat_id,userId)) continue;
        const count = counts.get(userId) || 0;
        if (count >= perUserLimit) continue;
        counts.set(userId, count + 1);
        due.push(row);
        if (due.length >= limit) break;
      }
      return due;
    },

    async updateBaseline({ id, baseline, now = Date.now(), nextCheckAt = now + ALERT_CHECK_INTERVAL_MS }) {
      await db.prepare(
        `UPDATE alerts
            SET baseline_json = ?, last_checked_at = ?, next_check_at = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(JSON.stringify(baseline), now, nextCheckAt, now, Number(id)).run();
    },

    async reschedule({ id, now = Date.now(), nextCheckAt = now + ALERT_CHECK_INTERVAL_MS }) {
      await db.prepare(
        `UPDATE alerts
            SET last_checked_at = ?, next_check_at = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(now, nextCheckAt, now, Number(id)).run();
    },

    async hasDelivery(alertId, eventKey) {
      const row = await db.prepare(
        'SELECT 1 AS found FROM alert_deliveries WHERE alert_id = ? AND event_key = ? LIMIT 1',
      ).bind(Number(alertId), String(eventKey)).first();
      return Boolean(row);
    },

    async recordDelivery(alertId, eventKey, deliveredAt = Date.now()) {
      await db.prepare(
        `INSERT INTO alert_deliveries (alert_id, event_key, delivered_at)
         VALUES (?, ?, ?)
         ON CONFLICT(alert_id, event_key) DO NOTHING`,
      ).bind(Number(alertId), String(eventKey), deliveredAt).run();
    },
  };
}
