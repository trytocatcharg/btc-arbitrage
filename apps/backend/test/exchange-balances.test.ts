import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBackendConfig } from '../src/config.js';
import { createBalanceService } from '../src/exchanges/balance-service.js';
import { normalizeExtendedBalance, normalizeRisexBalance } from '../src/exchanges/balance-normalizers.js';

const receivedAt = new Date('2026-08-13T10:00:00.000Z');

test('normalizes Extended balance payload', () => {
  const balance = normalizeExtendedBalance({
    status: 'OK',
    data: {
      balance: '1200.50',
      equity: '1210.25',
      availableForTrade: '900.10',
      initialMargin: '300.15',
      unrealisedPnl: '9.75'
    }
  }, receivedAt);

  assert.equal(balance.exchangeId, 'extended');
  assert.equal(balance.status, 'available');
  assert.equal(balance.totalEquityUsd, '1210.25');
  assert.equal(balance.availableUsd, '900.10');
  assert.equal(balance.marginUsedUsd, '300.15');
  assert.equal(balance.unrealizedPnlUsd, '9.75');
});

test('normalizes Extended 404 as synthetic zero balance', () => {
  const balance = normalizeExtendedBalance({ syntheticZeroBalance: true }, receivedAt);

  assert.equal(balance.exchangeId, 'extended');
  assert.equal(balance.status, 'available');
  assert.equal(balance.totalEquityUsd, '0');
  assert.equal(balance.availableUsd, '0');
  assert.equal(balance.syntheticZeroBalance, true);
});

test('normalizes RISEx nested balance payload', () => {
  const balance = normalizeRisexBalance({
    data: {
      account: {
        cross_margin_balance: '550.42',
        available_balance: '500.12',
        initial_margin: '50.30',
        unrealized_pnl: '-1.25'
      }
    }
  }, receivedAt);

  assert.equal(balance.exchangeId, 'risex');
  assert.equal(balance.status, 'available');
  assert.equal(balance.totalEquityUsd, '550.42');
  assert.equal(balance.availableUsd, '500.12');
  assert.equal(balance.marginUsedUsd, '50.30');
  assert.equal(balance.unrealizedPnlUsd, '-1.25');
});

test('balance service reports missing credentials as unconfigured blocks', async () => {
  const service = createBalanceService(loadBackendConfig({
    BACKEND_PORT: '3002',
    RISEX_API_BASE_URL: 'https://example.test',
    EXTENDED_API_BASE_URL: 'https://example.test',
    EXTENDED_USER_AGENT: 'btc-arbitrage-test'
  }));

  const balances = await service.getAllBalances();
  assert.equal(balances.balances.length, 2);
  assert.deepEqual(balances.balances.map((balance) => balance.status), ['unconfigured', 'unconfigured']);
});
