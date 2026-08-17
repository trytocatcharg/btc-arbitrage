import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldNotifyLegClosure, shouldSuppressSignalForActiveTrades } from '../src/trading/trade-guards.js';

test('active trade gate suppresses otherwise eligible signal after durable trade creation', () => {
  const durableTradeRows = [{ id: 42, status: 'executing_limit', legs: ['long', 'short'] }];
  let notifierCalls = 0;
  if (!shouldSuppressSignalForActiveTrades(durableTradeRows.map(row => row.id))) notifierCalls += 1;
  assert.equal(notifierCalls, 0);
});

test('leg closure monitor notification is one-time and keeps remaining leg unhedged', () => {
  const state = { closed: false, unhedged: false, notified: false, notifications: 0 };
  const monitor = () => { if (shouldNotifyLegClosure({ positionClosed: true, alreadyNotified: state.notified })) { state.closed = true; state.unhedged = true; state.notified = true; state.notifications += 1; } };
  monitor(); monitor();
  assert.deepEqual(state, { closed: true, unhedged: true, notified: true, notifications: 1 });
});
