import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBackendConfig } from '../src/config.js';
import { createBalanceService } from '../src/exchanges/balance-service.js';
import { normalizeExtendedBalance, normalizeRisexBalance } from '../src/exchanges/balance-normalizers.js';
import type { FetchLike } from '../src/exchanges/http-client.js';

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

test('RISEx balance falls back to portfolio details when cross-margin endpoint returns HTTP 500', async () => {
  const fetchStub: FetchLike = async (input) => {
    const url = new URL(String(input));

    if (url.pathname === '/v1/account/cross-margin-balance') {
      return new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.pathname === '/v1/portfolio/details') {
      return new Response(JSON.stringify({
        data: {
          nav: '1450.75',
          free_collateral: '1200.50',
          margin_balance: '250.25',
          unrealized_pnl: '10.00'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.pathname === '/api/v1/user/balance') {
      return new Response(JSON.stringify({ syntheticZeroBalance: true }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }

    throw new Error(`Unexpected URL in test: ${url.toString()}`);
  };

  const service = createBalanceService(loadBackendConfig({
    BACKEND_PORT: '3002',
    RISEX_API_BASE_URL: 'https://example.test',
    RISEX_ACCOUNT_ADDRESS: '0x1234',
    EXTENDED_API_BASE_URL: 'https://example.test',
    EXTENDED_API_KEY: 'test-key',
    EXTENDED_USER_AGENT: 'btc-arbitrage-test'
  }), fetchStub);

  const balance = await service.getRisexBalance();

  assert.equal(balance.exchangeId, 'risex');
  assert.equal(balance.status, 'available');
  assert.equal(balance.totalEquityUsd, '1450.75');
  assert.equal(balance.availableUsd, '1200.50');
  assert.equal(balance.unrealizedPnlUsd, '10.00');
});
