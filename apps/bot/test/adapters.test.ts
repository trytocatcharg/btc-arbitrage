import assert from 'node:assert/strict';
import test from 'node:test';
import { createRisexAdapter, normalizeRisexTimestamp } from '../src/exchanges/risex/risex-client.js';
import { createExtendedAdapter } from '../src/exchanges/extended/extended-client.js';

test('normalizeRisexTimestamp converts nanoseconds to milliseconds', () => {
  assert.equal(normalizeRisexTimestamp(1_704_067_200_000_000_000).toISOString(), '2024-01-01T00:00:00.000Z');
});

test('RISEx adapter normalizes mark price from market payload', async () => {
  const adapter = createRisexAdapter({ apiBaseUrl: 'https://example.test', tradingEnabled: false }, {
    async get() { return { data: [{ market_id: 'BTC-PERP', symbol: 'BTCUSDT', mark_price: '100000', timestamp: '1704067200000000000' }] }; }
  });
  const snapshot = await adapter.getPriceSnapshot({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'mark' });
  assert.equal(snapshot.exchangeId, 'risex');
  assert.equal(snapshot.externalMarketId, 'BTC-PERP');
  assert.equal(snapshot.priceUsd, '100000');
});

test('RISEx adapter handles nested data.markets and BTC/USDC market naming', async () => {
  const adapter = createRisexAdapter({ apiBaseUrl: 'https://example.test', tradingEnabled: false }, {
    async get() {
      return {
        data: {
          markets: [
            {
              market_id: 1,
              display_name: 'BTC/USDC',
              base_asset_symbol: 'BTC',
              mark_price: '100010.5',
              timestamp: '1704067200000000000'
            }
          ]
        }
      };
    }
  });

  const snapshot = await adapter.getPriceSnapshot({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'mark' });
  assert.equal(snapshot.externalMarketId, '1');
  assert.equal(snapshot.priceUsd, '100010.5');
  assert.equal(snapshot.exchangeTimestamp.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('Extended adapter normalizes mark price from market payload', async () => {
  const adapter = createExtendedAdapter({ apiBaseUrl: 'https://example.test', tradingEnabled: false, userAgent: 'btc-arbitrage-test' }, {
    async get() { return { data: [{ name: 'BTC-USD', markPrice: '99960', updatedAt: '2026-01-01T00:00:00.000Z' }] }; }
  });
  const snapshot = await adapter.getPriceSnapshot({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'mark' });
  assert.equal(snapshot.exchangeId, 'extended');
  assert.equal(snapshot.externalMarketId, 'BTC-USD');
  assert.equal(snapshot.priceUsd, '99960');
});

test('Extended adapter handles marketStats markPrice from BTC-USD payload', async () => {
  const adapter = createExtendedAdapter({ apiBaseUrl: 'https://example.test', tradingEnabled: false, userAgent: 'btc-arbitrage-test' }, {
    async get() {
      return {
        status: 'OK',
        data: [
          {
            name: 'BTCSPOT-USD',
            type: 'SPOT',
            assetName: 'BTCSPOT',
            marketStats: {
              markPrice: '0',
              indexPrice: '99969.5',
              lastPrice: '99971'
            }
          },
          {
            name: 'BTC-USD',
            type: 'PERPETUAL',
            assetName: 'BTC',
            marketStats: {
              markPrice: '99970.25',
              indexPrice: '99969.5',
              lastPrice: '99971'
            }
          }
        ]
      };
    }
  });

  const snapshot = await adapter.getPriceSnapshot({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'mark' });
  assert.equal(snapshot.externalMarketId, 'BTC-USD');
  assert.equal(snapshot.priceUsd, '99970.25');
});
