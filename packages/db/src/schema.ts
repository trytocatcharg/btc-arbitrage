import { boolean, decimal, index, int, json, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

export const tradeStatuses = ['planned', 'open', 'closing', 'closed', 'cancelled', 'failed'] as const;
export type TradeStatus = (typeof tradeStatuses)[number];

export const openTradeStatuses: readonly TradeStatus[] = ['planned', 'open', 'closing'];

export const tradeLegSides = ['long', 'short'] as const;
export type TradeLegSide = (typeof tradeLegSides)[number];

export const tradeLegStatuses = ['planned', 'submitted', 'open', 'closed', 'cancelled', 'failed'] as const;
export type TradeLegStatus = (typeof tradeLegStatuses)[number];

export const priceSnapshots = mysqlTable('price_snapshots', {
  id: int('id').autoincrement().primaryKey(),
  exchangeId: varchar('exchange_id', { length: 32 }).notNull(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  externalMarketId: varchar('external_market_id', { length: 128 }),
  marketType: varchar('market_type', { length: 32 }).notNull(),
  priceSource: varchar('price_source', { length: 16 }).notNull(),
  priceUsd: decimal('price_usd', { precision: 24, scale: 8 }).notNull(),
  bidUsd: decimal('bid_usd', { precision: 24, scale: 8 }),
  askUsd: decimal('ask_usd', { precision: 24, scale: 8 }),
  exchangeTimestamp: timestamp('exchange_timestamp').notNull(),
  receivedAt: timestamp('received_at').notNull(),
  raw: json('raw')
}, (table) => ({
  exchangeSymbolIdx: index('price_exchange_symbol_idx').on(table.exchangeId, table.symbol)
}));

export const spreadSnapshots = mysqlTable('spread_snapshots', {
  id: int('id').autoincrement().primaryKey(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  marketType: varchar('market_type', { length: 32 }).notNull(),
  priceSource: varchar('price_source', { length: 16 }).notNull(),
  exchangeA: varchar('exchange_a', { length: 32 }).notNull(),
  exchangeB: varchar('exchange_b', { length: 32 }).notNull(),
  exchangeAPriceUsd: decimal('exchange_a_price_usd', { precision: 24, scale: 8 }).notNull(),
  exchangeBPriceUsd: decimal('exchange_b_price_usd', { precision: 24, scale: 8 }).notNull(),
  absoluteDiffUsd: decimal('absolute_diff_usd', { precision: 24, scale: 8 }).notNull(),
  diffBps: decimal('diff_bps', { precision: 24, scale: 8 }).notNull(),
  direction: varchar('direction', { length: 32 }).notNull(),
  thresholdUsd: decimal('threshold_usd', { precision: 24, scale: 8 }).notNull(),
  thresholdMatched: boolean('threshold_matched').notNull(),
  calculatedAt: timestamp('calculated_at').notNull()
}, (table) => ({
  symbolCalculatedAtIdx: index('spread_symbol_calculated_at_idx').on(table.symbol, table.calculatedAt),
  matchedCalculatedAtIdx: index('spread_matched_calculated_at_idx').on(table.thresholdMatched, table.calculatedAt)
}));

export const signals = mysqlTable('signals', {
  id: int('id').autoincrement().primaryKey(),
  spreadId: int('spread_id').references(() => spreadSnapshots.id),
  longExchange: varchar('long_exchange', { length: 32 }).notNull(),
  shortExchange: varchar('short_exchange', { length: 32 }).notNull(),
  source: varchar('source', { length: 32 }).notNull(),
  leverage: int('leverage').notNull(),
  thresholdUsd: decimal('threshold_usd', { precision: 24, scale: 8 }).notNull(),
  observedDiffUsd: decimal('observed_diff_usd', { precision: 24, scale: 8 }).notNull(),
  reason: varchar('reason', { length: 512 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull()
}, (table) => ({
  statusCreatedAtIdx: index('signal_status_created_at_idx').on(table.status, table.createdAt),
  spreadIdx: index('signal_spread_idx').on(table.spreadId)
}));

export const trades = mysqlTable('trades', {
  id: int('id').autoincrement().primaryKey(),
  signalId: int('signal_id').references(() => signals.id),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  marketType: varchar('market_type', { length: 32 }).notNull(),
  priceSource: varchar('price_source', { length: 16 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull(),
  status: mysqlEnum('status', tradeStatuses).notNull(),
  longExchange: varchar('long_exchange', { length: 32 }).notNull(),
  shortExchange: varchar('short_exchange', { length: 32 }).notNull(),
  leverage: int('leverage').notNull(),
  entrySpreadUsd: decimal('entry_spread_usd', { precision: 24, scale: 8 }),
  exitSpreadUsd: decimal('exit_spread_usd', { precision: 24, scale: 8 }),
  realizedPnlUsd: decimal('realized_pnl_usd', { precision: 24, scale: 8 }),
  unrealizedPnlUsd: decimal('unrealized_pnl_usd', { precision: 24, scale: 8 }),
  totalFeesUsd: decimal('total_fees_usd', { precision: 24, scale: 8 }),
  openedAt: timestamp('opened_at'),
  closedAt: timestamp('closed_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, (table) => ({
  statusCreatedAtIdx: index('trade_status_created_at_idx').on(table.status, table.createdAt),
  statusOpenedAtIdx: index('trade_status_opened_at_idx').on(table.status, table.openedAt),
  signalIdx: index('trade_signal_idx').on(table.signalId),
  symbolStatusIdx: index('trade_symbol_status_idx').on(table.symbol, table.status)
}));

export const tradeLegs = mysqlTable('trade_legs', {
  id: int('id').autoincrement().primaryKey(),
  tradeId: int('trade_id').notNull().references(() => trades.id),
  exchangeId: varchar('exchange_id', { length: 32 }).notNull(),
  side: mysqlEnum('side', tradeLegSides).notNull(),
  status: mysqlEnum('status', tradeLegStatuses).notNull(),
  entryPriceUsd: decimal('entry_price_usd', { precision: 24, scale: 8 }),
  exitPriceUsd: decimal('exit_price_usd', { precision: 24, scale: 8 }),
  quantityBase: decimal('quantity_base', { precision: 24, scale: 10 }),
  quantityUsd: decimal('quantity_usd', { precision: 24, scale: 8 }),
  entryFeeUsd: decimal('entry_fee_usd', { precision: 24, scale: 8 }),
  exitFeeUsd: decimal('exit_fee_usd', { precision: 24, scale: 8 }),
  fundingFeeUsd: decimal('funding_fee_usd', { precision: 24, scale: 8 }),
  realizedPnlUsd: decimal('realized_pnl_usd', { precision: 24, scale: 8 }),
  externalPositionId: varchar('external_position_id', { length: 128 }),
  entryOrderId: varchar('entry_order_id', { length: 128 }),
  exitOrderId: varchar('exit_order_id', { length: 128 }),
  openedAt: timestamp('opened_at'),
  closedAt: timestamp('closed_at'),
  raw: json('raw')
}, (table) => ({
  tradeIdx: index('trade_leg_trade_idx').on(table.tradeId),
  exchangeStatusIdx: index('trade_leg_exchange_status_idx').on(table.exchangeId, table.status),
  tradeSideIdx: index('trade_leg_trade_side_idx').on(table.tradeId, table.side)
}));

export const tradeStatusHistory = mysqlTable('trade_status_history', {
  id: int('id').autoincrement().primaryKey(),
  tradeId: int('trade_id').notNull().references(() => trades.id),
  fromStatus: mysqlEnum('from_status', tradeStatuses),
  toStatus: mysqlEnum('to_status', tradeStatuses).notNull(),
  reason: varchar('reason', { length: 512 }),
  metadata: json('metadata'),
  changedAt: timestamp('changed_at').notNull()
}, (table) => ({
  tradeChangedAtIdx: index('trade_status_history_trade_changed_at_idx').on(table.tradeId, table.changedAt),
  toStatusChangedAtIdx: index('trade_status_history_to_status_changed_at_idx').on(table.toStatus, table.changedAt)
}));

export const telegramCommandLogs = mysqlTable('telegram_command_logs', {
  id: int('id').autoincrement().primaryKey(),
  chatId: varchar('chat_id', { length: 64 }).notNull(),
  command: varchar('command', { length: 64 }).notNull(),
  allowed: boolean('allowed').notNull(),
  responseSummary: varchar('response_summary', { length: 512 }),
  createdAt: timestamp('created_at').notNull()
}, (table) => ({
  chatCreatedAtIdx: index('telegram_command_chat_created_at_idx').on(table.chatId, table.createdAt),
  commandCreatedAtIdx: index('telegram_command_command_created_at_idx').on(table.command, table.createdAt)
}));

export const operations = mysqlTable('operations', {
  id: int('id').autoincrement().primaryKey(),
  signalId: int('signal_id').references(() => signals.id),
  tradeId: int('trade_id').references(() => trades.id),
  mode: varchar('mode', { length: 16 }).notNull(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  leverage: int('leverage').notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  guardrailReason: varchar('guardrail_reason', { length: 512 }),
  legs: json('legs'),
  createdAt: timestamp('created_at').notNull()
}, (table) => ({
  signalIdx: index('operation_signal_idx').on(table.signalId),
  tradeIdx: index('operation_trade_idx').on(table.tradeId),
  statusCreatedAtIdx: index('operation_status_created_at_idx').on(table.status, table.createdAt)
}));

export const events = mysqlTable('events', {
  id: int('id').autoincrement().primaryKey(),
  level: varchar('level', { length: 16 }).notNull(),
  type: varchar('type', { length: 64 }).notNull(),
  message: varchar('message', { length: 1024 }).notNull(),
  relatedEntityId: varchar('related_entity_id', { length: 128 }),
  metadata: json('metadata'),
  createdAt: timestamp('created_at').notNull()
}, (table) => ({
  typeCreatedAtIdx: index('event_type_created_at_idx').on(table.type, table.createdAt),
  levelCreatedAtIdx: index('event_level_created_at_idx').on(table.level, table.createdAt)
}));
