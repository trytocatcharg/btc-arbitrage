import assert from 'node:assert/strict';
import test from 'node:test';
import { priceSnapshots, spreadSnapshots, signals, operations, events } from '../src/schema.js';

test('exports initial monitoring schema tables', () => {
  assert.ok(priceSnapshots);
  assert.ok(spreadSnapshots);
  assert.ok(signals);
  assert.ok(operations);
  assert.ok(events);
});
