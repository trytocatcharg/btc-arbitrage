import assert from 'node:assert/strict';
import test from 'node:test';
import { SignalEngine } from '../src/signals/signal-engine.js';
import type { SpreadSnapshot } from '@btc-arbitrage/domain';

const spread: SpreadSnapshot = {
  symbol: 'BTCUSDT',
  marketType: 'perpetual',
  priceSource: 'mark',
  exchangeA: 'risex',
  exchangeB: 'extended',
  exchangeAPriceUsd: '100000',
  exchangeBPriceUsd: '99960',
  absoluteDiffUsd: '40',
  diffBps: '4',
  direction: 'a_above_b',
  thresholdUsd: '40',
  thresholdMatched: true,
  calculatedAt: new Date()
};

test('SignalEngine emits when absoluteDiffUsd is equal to configured threshold', () => {
  const signal = new SignalEngine({ thresholdUsd: '40', leverage: 3 }).evaluate(spread);
  assert.ok(signal);
  assert.equal(signal.longExchange, 'extended');
  assert.equal(signal.shortExchange, 'risex');
  assert.equal(signal.leverage, 3);
});

test('SignalEngine does not emit below threshold', () => {
  const signal = new SignalEngine({ thresholdUsd: '41', leverage: 3 }).evaluate(spread);
  assert.equal(signal, null);
});
