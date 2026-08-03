import { boolean, decimal, index, int, json, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

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
});

export const signals = mysqlTable('signals', {
  id: int('id').autoincrement().primaryKey(),
  spreadId: int('spread_id'),
  longExchange: varchar('long_exchange', { length: 32 }).notNull(),
  shortExchange: varchar('short_exchange', { length: 32 }).notNull(),
  source: varchar('source', { length: 32 }).notNull(),
  leverage: int('leverage').notNull(),
  thresholdUsd: decimal('threshold_usd', { precision: 24, scale: 8 }).notNull(),
  observedDiffUsd: decimal('observed_diff_usd', { precision: 24, scale: 8 }).notNull(),
  reason: varchar('reason', { length: 512 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull()
});

export const operations = mysqlTable('operations', {
  id: int('id').autoincrement().primaryKey(),
  signalId: int('signal_id'),
  mode: varchar('mode', { length: 16 }).notNull(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  leverage: int('leverage').notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  guardrailReason: varchar('guardrail_reason', { length: 512 }),
  legs: json('legs'),
  createdAt: timestamp('created_at').notNull()
});

export const events = mysqlTable('events', {
  id: int('id').autoincrement().primaryKey(),
  level: varchar('level', { length: 16 }).notNull(),
  type: varchar('type', { length: 64 }).notNull(),
  message: varchar('message', { length: 1024 }).notNull(),
  relatedEntityId: varchar('related_entity_id', { length: 128 }),
  metadata: json('metadata'),
  createdAt: timestamp('created_at').notNull()
});
