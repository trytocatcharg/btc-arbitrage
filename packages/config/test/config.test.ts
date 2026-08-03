import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadBotConfig, loadDotEnvFile, redactSecrets } from '../src/index.js';

test('loadBotConfig applies safe monitoring defaults', () => {
  const config = loadBotConfig({});
  assert.equal(config.exchangeA, 'risex');
  assert.equal(config.exchangeB, 'extended');
  assert.equal(config.priceSource, 'mark');
  assert.equal(config.minPriceDiffUsd, '40');
  assert.equal(config.leverage, 3);
  assert.equal(config.botExecutionMode, 'dry-run');
  assert.equal(config.botRunOnce, false);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.telegram.alertCooldownMs, 60000);
});

test('loadBotConfig rejects same exchange on both sides', () => {
  assert.throws(() => loadBotConfig({ EXCHANGE_A: 'risex', EXCHANGE_B: 'risex' }), /must be different/);
});

test('loadBotConfig validates Telegram credentials when enabled', () => {
  assert.throws(() => loadBotConfig({ TELEGRAM_ENABLED: 'true' }), /TELEGRAM_BOT_TOKEN/);
});

test('loadBotConfig blocks live execution in the monitoring-only slice', () => {
  assert.throws(() => loadBotConfig({ BOT_EXECUTION_MODE: 'live' }), /Live order placement is not implemented/);
  assert.throws(() => loadBotConfig({ ENABLE_ORDER_PLACEMENT: 'true' }), /Live order placement is not implemented/);
  assert.throws(() => loadBotConfig({ RISEX_TRADING_ENABLED: 'true' }), /Live order placement is not implemented/);
  assert.throws(() => loadBotConfig({ EXTENDED_TRADING_ENABLED: 'true' }), /Live order placement is not implemented/);
});

test('redactSecrets redacts token-like fields and database passwords', () => {
  const redacted = redactSecrets({ databaseUrl: 'mysql://u:pass@host/db', telegramBotToken: 'abc', nested: { apiKey: 'key' } });
  assert.deepEqual(redacted, { databaseUrl: '[REDACTED]', telegramBotToken: '[REDACTED]', nested: { apiKey: '[REDACTED]' } });
});


test('loadDotEnvFile searches upward from workspace cwd without overwriting existing env', () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const root = mkdtempSync(join(tmpdir(), 'btc-arbitrage-env-'));
  const nested = join(root, 'apps', 'bot');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, '.env'), 'TELEGRAM_BOT_TOKEN=file-token\nTELEGRAM_CHAT_ID=file-chat\n');
  process.env.TELEGRAM_BOT_TOKEN = 'existing-token';
  delete process.env.TELEGRAM_CHAT_ID;

  try {
    const loaded = loadDotEnvFile({ cwd: nested });
    assert.equal(loaded, join(root, '.env'));
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'existing-token');
    assert.equal(process.env.TELEGRAM_CHAT_ID, 'file-chat');
  } finally {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChatId;
  }
});
