import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTradeSummaryMessage } from '../src/notifications/trade-summary.js';
import { tradeLegs, trades } from '@btc-arbitrage/db';

test('buildTradeSummaryMessage returns a no-trades message when no active trades exist', async () => {
  const db = createFakeDb([], []);
  const registry = createFakeRegistry({});

  const message = await buildTradeSummaryMessage({ db, registry });
  assert.equal(message, '📭 No active trades found.');
});

test('buildTradeSummaryMessage summarizes multiple active trades with live quotes', async () => {
  const tradeRows = [
    {
      id: 8,
      signalId: null,
      symbol: 'BTCUSDT',
      marketType: 'perpetual',
      priceSource: 'mark',
      mode: 'dry-run',
      status: 'planned',
      longExchange: 'arcus',
      shortExchange: 'extended',
      leverage: 3,
      entrySpreadUsd: null,
      exitSpreadUsd: null,
      realizedPnlUsd: null,
      unrealizedPnlUsd: '0',
      totalFeesUsd: null,
      openedAt: null,
      closedAt: null,
      createdAt: new Date('2026-08-14T10:20:00.000Z'),
      updatedAt: new Date('2026-08-14T10:21:00.000Z')
    },
    {
      id: 7,
      signalId: null,
      symbol: 'BTCUSDT',
      marketType: 'perpetual',
      priceSource: 'mark',
      mode: 'dry-run',
      status: 'open',
      longExchange: 'extended',
      shortExchange: 'risex',
      leverage: 3,
      entrySpreadUsd: '50',
      exitSpreadUsd: null,
      realizedPnlUsd: null,
      unrealizedPnlUsd: '-100',
      totalFeesUsd: null,
      openedAt: new Date('2026-08-14T10:05:00.000Z'),
      closedAt: null,
      createdAt: new Date('2026-08-14T10:00:00.000Z'),
      updatedAt: new Date('2026-08-14T10:10:00.000Z')
    }
  ];

  const legRows = [
    {
      id: 1,
      tradeId: 7,
      exchangeId: 'extended',
      side: 'long',
      status: 'open',
      entryPriceUsd: '100000',
      exitPriceUsd: null,
      quantityBase: '0.5',
      quantityUsd: '50000',
      entryFeeUsd: null,
      exitFeeUsd: null,
      fundingFeeUsd: null,
      realizedPnlUsd: null,
      externalPositionId: null,
      entryOrderId: null,
      exitOrderId: null,
      openedAt: new Date('2026-08-14T10:05:10.000Z'),
      closedAt: null,
      raw: null
    },
    {
      id: 2,
      tradeId: 7,
      exchangeId: 'risex',
      side: 'short',
      status: 'open',
      entryPriceUsd: '100050',
      exitPriceUsd: null,
      quantityBase: '0.5',
      quantityUsd: '50025',
      entryFeeUsd: null,
      exitFeeUsd: null,
      fundingFeeUsd: null,
      realizedPnlUsd: null,
      externalPositionId: null,
      entryOrderId: null,
      exitOrderId: null,
      openedAt: new Date('2026-08-14T10:05:20.000Z'),
      closedAt: null,
      raw: null
    },
    {
      id: 3,
      tradeId: 8,
      exchangeId: 'arcus',
      side: 'long',
      status: 'planned',
      entryPriceUsd: '99980',
      exitPriceUsd: null,
      quantityBase: '0.2',
      quantityUsd: '19996',
      entryFeeUsd: null,
      exitFeeUsd: null,
      fundingFeeUsd: null,
      realizedPnlUsd: null,
      externalPositionId: null,
      entryOrderId: null,
      exitOrderId: null,
      openedAt: null,
      closedAt: null,
      raw: null
    },
    {
      id: 4,
      tradeId: 8,
      exchangeId: 'extended',
      side: 'short',
      status: 'planned',
      entryPriceUsd: '100010',
      exitPriceUsd: null,
      quantityBase: '0.2',
      quantityUsd: '20002',
      entryFeeUsd: null,
      exitFeeUsd: null,
      fundingFeeUsd: null,
      realizedPnlUsd: null,
      externalPositionId: null,
      entryOrderId: null,
      exitOrderId: null,
      openedAt: null,
      closedAt: null,
      raw: null
    }
  ];

  const registry = createFakeRegistry({
    extended: '99900',
    risex: '100150',
    arcus: '100020'
  });

  const message = await buildTradeSummaryMessage({ db: createFakeDb(tradeRows, legRows), registry });

  assert.match(message, /Active trade summary/);
  assert.match(message, /Trade #7 · BTCUSDT · open/);
  assert.match(message, /Trade #8 · BTCUSDT · planned/);
  assert.match(message, /LONG extended/);
  assert.match(message, /SHORT risex/);
  assert.match(message, /LONG arcus/);
  assert.match(message, /Estimated PnL:/);
});

function createFakeDb(tradeRows: unknown[], legRows: unknown[]) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === trades) {
            return {
              where() {
                return {
                  orderBy() {
                    return tradeRows;
                  }
                };
              }
            };
          }

          if (table === tradeLegs) {
            return {
              where() {
                return legRows;
              }
            };
          }

          throw new Error('Unexpected table in fake DB');
        }
      };
    }
  };
}

function createFakeRegistry(prices: Record<string, string>) {
  return {
    get(exchangeId: string) {
      const priceUsd = prices[exchangeId];
      if (!priceUsd) {
        throw new Error(`Missing price for ${exchangeId}`);
      }
      return {
        async getPriceSnapshot() {
          return {
            priceUsd
          };
        }
      };
    }
  };
}
