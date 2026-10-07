import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    telegramUserId: text('telegram_user_id').notNull(),
    chatId: text('chat_id').notNull(),
    targetType: text('target_type').notNull().default('hook'),
    chainId: integer('chain_id').notNull(),
    targetAddress: text('target_address').notNull(),
    rule: text('rule').notNull().default('hook_activity'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    baselineJson: text('baseline_json'),
    nextCheckAt: integer('next_check_at').notNull(),
    lastCheckedAt: integer('last_checked_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('alerts_user_target_unique').on(
      table.telegramUserId,
      table.chatId,
      table.chainId,
      table.targetAddress,
    ),
    index('alerts_due_idx').on(table.enabled, table.nextCheckAt),
    index('alerts_user_idx').on(table.telegramUserId, table.enabled),
  ],
);

export const alertDeliveries = sqliteTable(
  'alert_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertId: integer('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    deliveredAt: integer('delivered_at').notNull(),
  },
  (table) => [
    uniqueIndex('alert_deliveries_event_unique').on(table.alertId, table.eventKey),
    index('alert_deliveries_alert_idx').on(table.alertId, table.deliveredAt),
  ],
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
