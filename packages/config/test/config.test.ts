import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecutionMode } from '@btc-arbitrage/domain';
import { loadBotConfig, loadDotEnvFile, redactSecrets } from '../src/index.js';

test('loadBotConfig applies safe monitoring defaults', () => {
  const config = loadBotConfig({});
  assert.equal(config.exchangeA, 'risex');
  assert.equal(config.exchangeB, 'extended');
  assert.equal(config.priceSource, 'mark');
  assert.equal(config.minPriceDiffUsd, '40');
  assert.equal(config.leverage, 3);
  assert.equal(config.botExecutionMode, ExecutionMode.DryRun);
  assert.equal(config.botRunOnce, false);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.telegram.alertCooldownMs, 3600000);
});

test('loadBotConfig rejects same exchange on both sides', () => {
  assert.throws(() => loadBotConfig({ EXCHANGE_A: 'risex', EXCHANGE_B: 'risex' }), /must be different/);
});

test('loadBotConfig validates Telegram credentials when enabled', () => {
  assert.throws(() => loadBotConfig({ TELEGRAM_ENABLED: 'true' }), /TELEGRAM_BOT_TOKEN/);
});

test('loadBotConfig enforces consistent live execution gates', () => {
  assert.throws(() => loadBotConfig({ BOT_EXECUTION_MODE: ExecutionMode.Live }), /ENABLE_ORDER_PLACEMENT must be true/);
  assert.throws(() => loadBotConfig({ ENABLE_ORDER_PLACEMENT: 'true' }), /BOT_EXECUTION_MODE must be live/);
  const config = loadBotConfig({ BOT_EXECUTION_MODE: ExecutionMode.Live, ENABLE_ORDER_PLACEMENT: 'true' });
  assert.equal(config.botExecutionMode, ExecutionMode.Live);
  assert.equal(config.enableOrderPlacement, true);
});

test('loadBotConfig accepts exchange trading flags while global order placement stays disabled', () => {
  const config = loadBotConfig({ RISEX_TRADING_ENABLED: 'true', EXTENDED_TRADING_ENABLED: 'true' });
  assert.equal(config.botExecutionMode, ExecutionMode.DryRun);
  assert.equal(config.enableOrderPlacement, false);
  assert.equal(config.risex.tradingEnabled, true);
  assert.equal(config.extended.tradingEnabled, true);
});

test('loadBotConfig parses configurable TP/SL percentages for open-trade protection', () => {
  const config = loadBotConfig({ OPEN_TRADE_TAKE_PROFIT_PERCENT: '7.5', OPEN_TRADE_STOP_LOSS_PERCENT: '2.5' });
  assert.equal(config.openTrade.takeProfitPercent, '7.5');
  assert.equal(config.openTrade.stopLossPercent, '2.5');
});

test('loadBotConfig parses the SPYQQQ_* env family into config.spyQqq independently of GOLDSILVER_*', () => {
  const config = loadBotConfig({});
  // Same shape and defaults as the metals section until overridden.
  assert.equal(config.spyQqq.marginUsd, config.goldSilver.marginUsd);
  assert.equal(config.spyQqq.leverage, config.goldSilver.leverage);
  assert.equal(config.spyQqq.tpMinNetUsd, config.goldSilver.tpMinNetUsd);
  assert.equal(config.spyQqq.maxEntrySlippageBps, config.goldSilver.maxEntrySlippageBps);
  assert.equal(config.spyQqq.hedgeRetryAttempts, config.goldSilver.hedgeRetryAttempts);

  const overridden = loadBotConfig({
    SPYQQQ_MARGIN_USD: '35',
    SPYQQQ_LEVERAGE: '5',
    SPYQQQ_TP_MIN_NET_USD: '15',
    SPYQQQ_MAX_ENTRY_SLIPPAGE_BPS: '60',
    SPYQQQ_HEDGE_RETRY_ATTEMPTS: '4',
  });
  assert.equal(Number(overridden.spyQqq.marginUsd), 35);
  assert.equal(overridden.spyQqq.leverage, 5);
  assert.equal(Number(overridden.spyQqq.tpMinNetUsd), 15);
  assert.equal(overridden.spyQqq.maxEntrySlippageBps, 60);
  assert.equal(overridden.spyQqq.hedgeRetryAttempts, 4);
  // The metals section is untouched by the SPYQQQ_* overrides.
  assert.equal(overridden.goldSilver.leverage, 3);
});

test('loadBotConfig names SPYQQQ_* variables in validation errors', () => {
  assert.throws(() => loadBotConfig({ SPYQQQ_RSI_PERIOD: '1' }), /SPYQQQ_RSI_PERIOD/);
  assert.throws(() => loadBotConfig({ SPYQQQ_CANDLE_TIMEFRAME: '7h' }), /SPYQQQ_CANDLE_TIMEFRAME/);
});

test('loadBotConfig rejects Arcus-pair pseudo-symbols as BTC_SYMBOL', () => {
  assert.throws(() => loadBotConfig({ BTC_SYMBOL: 'SPYQQQ' }), /Arcus-pair pseudo-symbol/);
  assert.throws(() => loadBotConfig({ BTC_SYMBOL: 'GOLDSILVER' }), /Arcus-pair pseudo-symbol/);
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
