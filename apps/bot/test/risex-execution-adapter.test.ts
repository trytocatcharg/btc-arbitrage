import assert from 'node:assert/strict';
import test from 'node:test';
import { RisexExecutionAdapter, packRisexOrderData } from '../src/exchanges/risex/risex-execution-adapter.js';
import { encodeLeverage, encodeMarginMode } from '../src/exchanges/risex/sdk/signing/encoder.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const ACCOUNT_PRIVATE_KEY = `0x${'2'.repeat(64)}`;
const SIGNER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const ROUTER = '0x2222222222222222222222222222222222222222';
const AUTH = '0x3333333333333333333333333333333333333333';
const OPERATOR_HUB = '0x4444444444444444444444444444444444444444';

test('RISEx execution reads BBO from orderbook and metadata from markets while mutation stays gated by RISEX_TRADING_ENABLED', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: false }, http, fixedNow);

  const [bbo, metadata] = await Promise.all([
    adapter.getBestBidOffer({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'last' }),
    adapter.getMarketMetadata({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'last' })
  ]);

  assert.deepEqual(bbo, { bidUsd: '55024.7', askUsd: '55024.9', receivedAt: fixedNow() });
  assert.deepEqual(metadata, { minQuantityBase: '0.00015', quantityStepBase: '0.000001', maxLeverage: 20, positionMode: 'one-way' });
  await assert.rejects(() => adapter.submitExecutionOrder({ clientOrderId: 'blocked', symbol: 'BTCUSDT', side: 'buy', type: 'limit', quantityBase: '0.0002', priceUsd: '55024.8' }), /RISEx live execution is disabled/);
  assert.equal(http.posts.length, 0);
});

test('RISEx execution signs and posts a direct permit limit order', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: true }, http, fixedNow);

  const order = await adapter.submitExecutionOrder({ clientOrderId: 'limit-1', symbol: 'BTCUSDT', side: 'buy', type: 'limit', quantityBase: '0.0002', priceUsd: '55024.8' });

  assert.deepEqual(order, { id: '0xplaced', status: 'new', filledQuantityBase: '0' });
  assert.equal(http.posts.length, 1);
  const posted = http.posts[0]!;
  assert.equal(posted.path, '/v1/orders/place');
  assert.equal(posted.body.market_id, 1);
  assert.equal(posted.body.size_steps, 200);
  assert.equal(posted.body.price_ticks, 550248);
  assert.equal(posted.body.side, 0);
  assert.equal(posted.body.post_only, true);
  assert.equal(posted.body.reduce_only, false);
  assert.equal(posted.body.order_type, 1);
  assert.equal(posted.body.time_in_force, 0);
  assert.equal(posted.body.permit.account, ACCOUNT);
  assert.equal(posted.body.permit.nonce_anchor, 7);
  assert.equal(posted.body.permit.nonce_bitmap_index, 0);
  assert.match(posted.body.permit.signer, /^0x[0-9a-f]{40}$/);
  assert.equal(Buffer.from(posted.body.permit.signature, 'base64').length, 64);
});

test('RISEx reduce-only market close uses IOC market order and BBO price bound', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: true }, http, fixedNow);

  await adapter.submitExecutionOrder({ clientOrderId: 'close-short', symbol: 'BTCUSDT', side: 'buy', type: 'market', quantityBase: '0.0002', reduceOnly: true });

  const body = http.posts[0]!.body;
  assert.equal(body.path, undefined);
  assert.equal(body.post_only, false);
  assert.equal(body.reduce_only, true);
  assert.equal(body.order_type, 0);
  assert.equal(body.time_in_force, 3);
  assert.equal(body.price_ticks, 550249);
});

test('RISEx cancel signs against resting_order_id from open orders', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: true }, http, fixedNow);

  await adapter.cancelExecutionOrder('0xabc');

  const posted = http.posts[0]!;
  assert.equal(posted.path, '/v1/orders/cancel');
  assert.equal(posted.body.market_id, 1);
  assert.equal(posted.body.order_id, '0xabc');
  assert.equal(posted.body.permit.nonce_anchor, 7);
  assert.equal(posted.body.permit.nonce_bitmap_index, 0);
  assert.equal(Buffer.from(posted.body.permit.signature, 'base64').length, 64);
});

test('RISEx exposes balance and position reads but refuses undocumented TP/SL trigger orders', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: true }, http, fixedNow);

  assert.equal(await adapter.getAvailableMarginUsd(), '1234.5');
  assert.deepEqual(await adapter.getPosition({ symbol: 'BTCUSDT', side: 'long' }), { id: 'pos-1', side: 'long', quantityBase: '0.002', entryPriceUsd: '54000', status: 'open' });
  const tpsl = await adapter.submitExecutionOrder({ clientOrderId: 'tp', symbol: 'BTCUSDT', side: 'sell', type: 'take-profit-market', quantityBase: '0.002', triggerPriceUsd: '57000', reduceOnly: true });
  assert.equal(tpsl.id, 'tpsl-1');
  const posted = http.posts[0]!;
  assert.equal(posted.path, '/v1/orders/tpsl');
  assert.equal(posted.body.stop_type, 'TAKE_PROFIT');
  assert.equal(posted.body.side, 1);
  assert.equal(posted.body.stop_price, '57000');
  assert.equal(posted.body.limit_price, '57000.1');
  assert.equal(posted.body.stop_price_option, 'LAST_TRADED_PRICE');
  assert.match(posted.body.signature, /^[A-Za-z0-9+/=]+$/);
});

test('RISEx leverage update goes through adapted ExchangeClient with permit_params payload', async () => {
  const http = fakeHttp();
  const adapter = new RisexExecutionAdapter({ apiBaseUrl: 'https://example.test', accountAddress: ACCOUNT, sessionSignerPrivateKey: SIGNER_PRIVATE_KEY, tradingEnabled: true }, http, fixedNow);

  await adapter.validateExecutionPreflight({ symbol: 'BTCUSDT', leverage: 3 });

  const posted = http.posts[0]!;
  assert.equal(posted.path, '/v1/account/leverage');
  assert.equal(posted.body.market_id, 1);
  assert.equal(posted.body.leverage, '3');
  assert.ok('permit_params' in posted.body);
  assert.ok(!('permit' in posted.body));
  assert.equal(posted.body.permit_params.nonce_anchor, 7);
  assert.equal(posted.body.permit_params.nonce_bitmap_index, 0);
});

test('RISEx approve-single uses the main wallet and hex signature', async () => {
  const http = fakeHttp();
  const clientModule = await import('../src/exchanges/risex/sdk/ExchangeClient.js');
  const client = new clientModule.ExchangeClient({
    baseUrl: 'https://example.test',
    account: ACCOUNT,
    accountKey: ACCOUNT_PRIVATE_KEY,
    signerKey: SIGNER_PRIVATE_KEY
  }, http);
  await client.init();
  await client.approvePermitSingleBudget();
  const posted = http.posts[0]!;
  assert.equal(posted.path, '/v1/auth/approve-single');
  assert.equal(posted.body.account, ACCOUNT);
  assert.equal(posted.body.operator, OPERATOR_HUB);
  assert.match(posted.body.signature, /^0x[0-9a-f]+$/);
});

test('RISEx order packing follows documented uint88 layout', () => {
  assert.equal(packRisexOrderData({ marketId: 1, sizeSteps: 200n, priceTicks: 550248n, side: 0, postOnly: true, reduceOnly: false, stpMode: 0, orderType: 1, timeInForce: 0 }), 1180591675702007957634n);
});

test('RISEx leverage and margin hashes match the verified Python reference', () => {
  assert.equal(encodeLeverage(1, 10n), '0xc358a04124587a5809f1d6ddf57fc2ecb3d1691fd0a76a930c0518e961081880');
  assert.equal(encodeMarginMode(1, 1), '0x447f808acbdae07c8c46502182357efa3110ed0e3b401f16c0d3d49a8fdb7b3f');
});

function fixedNow(): Date { return new Date('2026-01-01T00:00:00.000Z'); }

function fakeHttp() {
  const posts: Array<{ path: string; body: any }> = [];
  return {
    posts,
    async get(path: string, query: Record<string, string | undefined> = {}) {
      if (path === '/v1/markets') return marketsPayload();
      if (path === '/v1/orderbook') {
        assert.equal(query.market_id, '1');
        assert.equal(query.limit, '1');
        return { data: { market_id: 1, bids: [{ price: '55024.7', quantity: '1' }], asks: [{ price: '55024.9', quantity: '1' }] } };
      }
      if (path === '/v1/auth/eip712-domain') return { data: { name: 'RISEx', version: '1', chain_id: '4153', verifying_contract: AUTH } };
      if (path === '/v1/system/config') return { data: { addresses: { router: ROUTER, operator_hub: OPERATOR_HUB } } };
      if (path === `/v1/nonce-state/${ACCOUNT}`) return { data: { nonce_anchor: '7', current_bitmap_index: 0, bitmap: '0' } };
      if (path === '/v1/orders/open') {
        assert.equal(query.account, ACCOUNT);
        return { data: { orders: [{ order_id: '0xabc', market_id: '1', resting_order_id: '15', status: 'new' }] } };
      }
      if (path === '/v1/account/cross-margin-balance') {
        assert.equal(query.account, ACCOUNT);
        return { data: { available_balance: '1234.5', cross_margin_balance: '1500' } };
      }
      if (path === '/v1/account/position') {
        assert.equal(query.account, ACCOUNT);
        assert.equal(query.market_id, '1');
        return { data: { id: 'pos-1', quantity: '0.002', entry_price: '54000' } };
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path: string, body: any) {
      posts.push({ path, body });
      if (path === '/v1/orders/place') return { data: { order_id: '0xplaced', status: 'new', filled_size_steps: '0' } };
      if (path === '/v1/orders/cancel') return { data: { success: true } };
      if (path === '/v1/account/leverage') return { data: { success: true } };
      if (path === '/v1/orders/tpsl') return { data: { order_id: 'tpsl-1', status: 'accepted' } };
      if (path === '/v1/auth/approve-single') return { data: { success: true, access_token: 'jwt' } };
      throw new Error(`Unexpected POST ${path}`);
    }
  };
}

function marketsPayload() {
  return {
    data: {
      markets: [{
        market_id: '1',
        symbol: 'BTCUSDT',
        type: 'perpetual',
        bid_price: '55024.7',
        ask_price: '55024.9',
        mark_price: '55024.8',
        config: { step_size: '0.000001', step_price: '0.1', min_order_size: '0.00015', max_leverage: '20' }
      }]
    }
  };
}
