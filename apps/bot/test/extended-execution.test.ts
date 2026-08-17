import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtendedAdapter } from '../src/exchanges/extended/extended-client.js';
import { createExtendedSignedOrder } from '../src/exchanges/extended/extended-order-signing.js';

const privateKey = '0x659127796b268530385f753efee81112c628b2bf266e025d3b52d16204c5504';
const market = {
  name: 'BTC-USD',
  type: 'PERPETUAL',
  assetName: 'BTC',
  marketStats: { markPrice: '100000', indexPrice: '99950', lastPrice: '100010' },
  tradingConfig: { minOrderSize: '0.001', minOrderSizeChange: '0.0001', minPriceChange: '0.1', maxPositionValue: '10000000', maxLeverage: '50' },
  l2Config: { collateralId: '0x35596841893e0d17079c27b2d72db1694f26a1932a7429144b439ba0807d29c', collateralResolution: 1_000_000, syntheticId: '0x4254432d3130000000000000000000', syntheticResolution: 10_000_000_000 }
};

test('Extended signing matches the official TypeScript reference fixture', () => {
  const order = createExtendedSignedOrder({
    marketName: 'BTC-USD',
    orderType: 'LIMIT',
    side: 'SELL',
    amountOfSynthetic: '0.001',
    price: '43445.11680000',
    timeInForce: 'GTT',
    reduceOnly: false,
    postOnly: false,
    tpSlType: 'ORDER',
    takeProfit: { triggerPrice: '49000', triggerPriceType: 'MARK', price: '50000', priceType: 'LIMIT' },
    stopLoss: { triggerPrice: '40000', triggerPriceType: 'MARK', price: '39000', priceType: 'LIMIT' },
    now: new Date('2024-01-05T01:08:56.860Z'),
    nonce: 1473459052,
    ctx: {
      assetIdCollateral: market.l2Config.collateralId,
      assetIdSynthetic: market.l2Config.syntheticId,
      settlementResolutionCollateral: '1000000',
      settlementResolutionSynthetic: '10000000000',
      minOrderSizeChange: '0.0001',
      maxPositionValue: '10000000000',
      feeRate: '0.0002',
      vaultId: '10002',
      starkPrivateKey: privateKey,
      starknetDomain: { name: 'Perpetuals', version: 'v0', chainId: 'SN_SEPOLIA', revision: 1 },
      builderId: '2001',
      builderFee: '0.0012'
    }
  });

  assert.equal(order.id, '1088023465382590833070844354772991406799121939245800917524942990980270111150');
  assert.deepEqual(order.debuggingAmounts, { collateralAmount: '43445116', feeAmount: '60824', syntheticAmount: '10000000' });
  assert.deepEqual(order.settlement?.signature, {
    r: '0x2a89b52eea807bc7e22f8eedf636f4b9f4ecd9c90da7973840e5ef77cb8255c',
    s: '0x6913f549d532336c26959190ffae3e92f1e92b436da4e6025226320fefc320f'
  });
  assert.equal(order.takeProfit?.settlement.signature.r, '0x7b9a3c5ad98aa3831662d107b97d4310334cef9def0a622c4233358b8215958');
  assert.equal(order.stopLoss?.settlement.signature.s, '0x248e0bbce83f091d1db78005b06b427fe1c2816c36ca72c166fdbc61161a0bd');
});

test('Extended execution keeps live order placement disabled by default', async () => {
  const adapter = createExtendedAdapter({ apiBaseUrl: 'https://example.test', apiKey: 'api-key', starkPrivateKey: privateKey, vaultId: '10002', tradingEnabled: false, userAgent: 'btc-arbitrage-test' }, mockHttp());
  await assert.rejects(() => adapter.execution!.submitExecutionOrder({ clientOrderId: 'disabled', symbol: 'BTCUSDT', side: 'buy', type: 'market', quantityBase: '0.001' }), /Extended trading is disabled/);
});

test('Extended execution uses REST BBO and places signed IOC crossing market order', async () => {
  const http = mockHttp();
  const adapter = createExtendedAdapter({ apiBaseUrl: 'https://example.test', apiKey: 'api-key', starkPrivateKey: privateKey, vaultId: '10002', tradingEnabled: true, userAgent: 'btc-arbitrage-test' }, http);

  const bbo = await adapter.execution!.getBestBidOffer({ symbol: 'BTCUSDT', marketType: 'perpetual', priceSource: 'last' });
  assert.equal(bbo.bidUsd, '99990');
  assert.equal(bbo.askUsd, '100000');

  const placed = await adapter.execution!.submitExecutionOrder({ clientOrderId: 'm1', symbol: 'BTCUSDT', side: 'buy', type: 'market', quantityBase: '0.00123' });
  assert.equal(placed.status, 'filled');
  assert.equal(placed.averageFillPriceUsd, '100010');

  const post = http.posts[0];
  assert.equal(post.path, '/api/v1/user/order');
  assert.equal(post.options?.private, true);
  assert.equal(post.body.type, 'MARKET');
  assert.equal(post.body.side, 'BUY');
  assert.equal(post.body.timeInForce, 'IOC');
  assert.equal(post.body.qty, '0.0012');
  assert.equal(post.body.price, '101500');
  assert.ok(post.body.settlement.signature.r.startsWith('0x'));
  assert.equal(JSON.stringify(post.body).includes(privateKey), false);
  assert.deepEqual(http.gets.filter((call) => call.path === '/api/v1/user/fees').map((call) => call.options?.private), [true]);
});

test('Extended execution signs reduce-only TPSL market protection and wires query/cancel/positions', async () => {
  const http = mockHttp();
  const adapter = createExtendedAdapter({ apiBaseUrl: 'https://example.test', apiKey: 'api-key', starkPrivateKey: privateKey, vaultId: '10002', tradingEnabled: true, userAgent: 'btc-arbitrage-test' }, http);

  await adapter.execution!.submitExecutionOrder({ clientOrderId: 'sl1', symbol: 'BTCUSDT', side: 'sell', type: 'stop-market', quantityBase: '0.002', triggerPriceUsd: '99000', reduceOnly: true });
  const body = http.posts[0].body;
  assert.equal(body.type, 'TPSL');
  assert.equal(body.reduceOnly, true);
  assert.equal(body.settlement, undefined);
  assert.equal(body.stopLoss.priceType, 'MARKET');
  assert.equal(body.stopLoss.price, '97515');
  assert.ok(body.stopLoss.settlement.signature.s.startsWith('0x'));

  const queried = await adapter.execution!.getExecutionOrder('order-1');
  assert.equal(queried.status, 'filled');
  await adapter.execution!.cancelExecutionOrder('order-1');
  assert.equal(http.deletes[0].path, '/api/v1/user/order/order-1');
  const position = await adapter.execution!.getPosition({ symbol: 'BTCUSDT', side: 'long' });
  assert.equal(position?.quantityBase, '0.002');
  assert.equal(http.gets.some((call) => call.path === '/api/v1/user/positions' && call.options?.query?.side === 'LONG'), true);
});

function mockHttp() {
  const gets: Array<{ path: string; options?: { private?: boolean; query?: Record<string, unknown> } }> = [];
  const posts: Array<{ path: string; body: any; options?: { private?: boolean; query?: Record<string, unknown> } }> = [];
  const deletes: Array<{ path: string; options?: { private?: boolean; query?: Record<string, unknown> } }> = [];
  return {
    gets,
    posts,
    deletes,
    async get(path: string, options?: { private?: boolean; query?: Record<string, unknown> }) {
      gets.push({ path, options });
      if (path === '/api/v1/info/markets') return { status: 'OK', data: [market] };
      if (path === '/api/v1/info/markets/BTC-USD/orderbook') return { status: 'OK', data: { market: 'BTC-USD', bid: [{ price: '99990', qty: '1' }], ask: [{ price: '100000', qty: '1' }] } };
      if (path === '/api/v1/user/fees') return { status: 'OK', data: [{ market: 'BTC-USD', makerFeeRate: '0', takerFeeRate: '0.00025', builderFeeRate: '0' }] };
      if (path === '/api/v1/info/starknet') return { status: 'OK', data: { name: 'Perpetuals', version: 'v0', chainId: 'SN_SEPOLIA', revision: 1 } };
      if (path === '/api/v1/user/orders/order-1') return { status: 'OK', data: { id: 'order-1', status: 'FILLED', filledQty: '0.002', averagePrice: '100010' } };
      if (path === '/api/v1/user/positions') return { status: 'OK', data: [{ id: 'pos-1', market: 'BTC-USD', side: 'LONG', size: '0.002', openPrice: '100000' }] };
      if (path === '/api/v1/user/balance') return { status: 'OK', data: { equity: '1000', availableForTrade: '900' } };
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path: string, body: any, options?: { private?: boolean; query?: Record<string, unknown> }) {
      posts.push({ path, body, options });
      return { status: 'OK', data: { id: 'order-1', externalId: body.id } };
    },
    async delete(path: string, options?: { private?: boolean; query?: Record<string, unknown> }) {
      deletes.push({ path, options });
      return { status: 'OK' };
    }
  };
}
