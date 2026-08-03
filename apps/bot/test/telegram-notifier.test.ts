import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAllowedTelegramChat, isAllowedTelegramChat, TelegramNotifier } from '../src/notifications/telegram-notifier.js';
import type { TradingSignal } from '@btc-arbitrage/domain';

const signal: TradingSignal = {
  symbol: 'BTCUSDT',
  marketType: 'perpetual',
  priceSource: 'mark',
  exchangeA: 'risex',
  exchangeB: 'extended',
  longExchange: 'extended',
  shortExchange: 'risex',
  exchangeAPriceUsd: '100000',
  exchangeBPriceUsd: '99960',
  absoluteDiffUsd: '40',
  thresholdUsd: '40',
  leverage: 3,
  reason: 'test',
  status: 'created',
  createdAt: new Date()
};

test('TelegramNotifier is a no-op when disabled', async () => {
  let called = false;
  const notifier = new TelegramNotifier({ enabled: false }, async () => { called = true; return new Response('{}'); });
  await notifier.notifySignal(signal);
  assert.equal(called, false);
});

test('TelegramNotifier sends signal through injected fetch without logging tokens', async () => {
  let requestedUrl = '';
  const notifier = new TelegramNotifier({ enabled: true, botToken: 'secret-token', chatId: ' 123456 ' }, async (url, init) => {
    requestedUrl = url;
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
    assert.equal(body.chat_id, '123456');
    assert.match(body.text, /BTC arbitrage signal/);
    return new Response('{"ok":true}', { status: 200 });
  });
  await notifier.notifySignal(signal);
  assert.match(requestedUrl, /api\.telegram\.org\/botsecret-token\/sendMessage/);
});

test('Telegram chat guard only allows configured TELEGRAM_CHAT_ID', () => {
  assert.equal(isAllowedTelegramChat({ id: 123456 }, '123456'), true);
  assert.equal(isAllowedTelegramChat({ id: '123456' }, ' 123456 '), true);
  assert.equal(isAllowedTelegramChat({ id: 999999 }, '123456'), false);
  assert.equal(isAllowedTelegramChat(undefined, '123456'), false);
  assert.doesNotThrow(() => assertAllowedTelegramChat({ id: '123456' }, '123456'));
  assert.throws(() => assertAllowedTelegramChat({ id: '999999' }, '123456'), /chat id is not allowed/);
});


test('TelegramNotifier suppresses repeated alerts for the same signal during cooldown', async () => {
  let calls = 0;
  let now = 1_000;
  const notifier = new TelegramNotifier(
    { enabled: true, botToken: 'secret-token', chatId: 'chat', alertCooldownMs: 60_000 },
    async () => {
      calls += 1;
      return new Response('{"ok":true}', { status: 200 });
    },
    () => now
  );

  await notifier.notifySignal(signal);
  now += 30_000;
  await notifier.notifySignal(signal);
  now += 31_000;
  await notifier.notifySignal(signal);

  assert.equal(calls, 2);
});

test('TelegramNotifier suppresses retries during cooldown after Telegram failure', async () => {
  let calls = 0;
  let now = 1_000;
  const notifier = new TelegramNotifier(
    { enabled: true, botToken: 'secret-token', chatId: 'chat', alertCooldownMs: 60_000 },
    async () => {
      calls += 1;
      return new Response('{"ok":false}', { status: 500 });
    },
    () => now
  );

  await assert.rejects(() => notifier.notifySignal(signal), /Telegram sendMessage failed/);
  now += 30_000;
  await notifier.notifySignal(signal);

  assert.equal(calls, 1);
});
