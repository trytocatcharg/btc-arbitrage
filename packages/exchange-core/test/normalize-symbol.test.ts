import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSymbol } from '../src/index.js';

test('normalizeSymbol removes delimiters and uppercases symbols', () => {
  assert.equal(normalizeSymbol('BTC-USD'), 'BTCUSD');
  assert.equal(normalizeSymbol('btc/usdt'), 'BTCUSDT');
});
