import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSpread, type PriceSnapshot } from '../src/index.js';

function price(exchangeId: 'risex' | 'extended', priceUsd: string): PriceSnapshot {
  return {
    exchangeId,
    symbol: 'BTCUSDT',
    marketType: 'perpetual',
    priceSource: 'mark',
    priceUsd,
    exchangeTimestamp: new Date('2026-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-01-01T00:00:01.000Z')
  };
}

test('calculateSpread matches threshold when absolute diff is equal to threshold', () => {
  const spread = calculateSpread({ exchangeA: price('risex', '100000'), exchangeB: price('extended', '99960'), thresholdUsd: '40' });
  assert.equal(spread.absoluteDiffUsd, '40');
  assert.equal(spread.direction, 'a_above_b');
  assert.equal(spread.thresholdMatched, true);
});

test('calculateSpread does not match threshold below configured diff', () => {
  const spread = calculateSpread({ exchangeA: price('risex', '100000'), exchangeB: price('extended', '99961'), thresholdUsd: '40' });
  assert.equal(spread.absoluteDiffUsd, '39');
  assert.equal(spread.thresholdMatched, false);
});
