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

export const executionIntents = sqliteTable(
  'execution_intents',
  {
    intentId: text('intent_id').primaryKey(),
    chainId: integer('chain_id').notNull(),
    takerAddress: text('taker_address').notNull(),
    transactionTo: text('transaction_to').notNull(),
    transactionDataHash: text('transaction_data_hash').notNull(),
    transactionValue: text('transaction_value').notNull(),
    expiresAt: integer('expires_at').notNull(),
    feeToken: text('fee_token').notNull(),
    grossFeeAmount: text('gross_fee_amount').notNull(),
    cashbackAmount: text('cashback_amount').notNull(),
    effectiveFeeAmount: text('effective_fee_amount').notNull(),
    grossFeeBps: integer('gross_fee_bps').notNull().default(100),
    cashbackBps: integer('cashback_bps').notNull().default(30),
    effectiveFeeBps: integer('effective_fee_bps').notNull().default(70),
    createdAt: integer('created_at').notNull(),
    consumedAt: integer('consumed_at'),
    transactionHash: text('transaction_hash'),
  },
  (table) => [
    uniqueIndex('execution_intents_transaction_unique').on(table.transactionHash),
    index('execution_intents_expiry_idx').on(table.expiresAt, table.consumedAt),
    index('execution_intents_wallet_idx').on(table.takerAddress, table.createdAt),
  ],
);

export const executionReceipts = sqliteTable(
  'execution_receipts',
  {
    transactionHash: text('transaction_hash').primaryKey(),
    intentId: text('intent_id').notNull().references(() => executionIntents.intentId, { onDelete: 'restrict' }),
    chainId: integer('chain_id').notNull(),
    takerAddress: text('taker_address').notNull(),
    blockNumber: text('block_number').notNull(),
    feeToken: text('fee_token').notNull(),
    grossFeeAmount: text('gross_fee_amount').notNull(),
    cashbackAmount: text('cashback_amount').notNull(),
    effectiveFeeAmount: text('effective_fee_amount').notNull(),
    confirmedAt: integer('confirmed_at').notNull(),
  },
  (table) => [
    uniqueIndex('execution_receipts_intent_unique').on(table.intentId),
    index('execution_receipts_wallet_idx').on(table.takerAddress, table.confirmedAt),
  ],
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
export type ExecutionIntent = typeof executionIntents.$inferSelect;
export type NewExecutionIntent = typeof executionIntents.$inferInsert;
export type ExecutionReceipt = typeof executionReceipts.$inferSelect;
export type NewExecutionReceipt = typeof executionReceipts.$inferInsert;
