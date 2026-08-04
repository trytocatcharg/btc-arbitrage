import { loadBotConfig, loadDotEnvFile, redactSecrets } from '@btc-arbitrage/config';
import { validateDbConnection } from '@btc-arbitrage/db';
import { createExchangeRegistry } from './exchanges/registry.js';
import { TelegramNotifier } from './notifications/telegram-notifier.js';
import { runPollingLoop } from './runtime/polling-loop.js';
import { createReadOnlyApiServer } from './api/read-only-api.js';

async function main() {
  console.log('btc-arbitrage bot process booting', {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    startedAt: new Date().toISOString()
  });

  const loadedEnvPath = loadDotEnvFile();
  console.log('Environment file status', { loaded: Boolean(loadedEnvPath), path: loadedEnvPath ?? null });

  const config = loadBotConfig();
  if (config.risex.tradingEnabled || config.extended.tradingEnabled || config.arcus.tradingEnabled) {
    console.warn('Exchange trading flags are enabled but ignored in this monitoring-only slice', {
      risexTradingEnabled: config.risex.tradingEnabled,
      extendedTradingEnabled: config.extended.tradingEnabled,
      arcusTradingEnabled: config.arcus.tradingEnabled,
      orderPlacementImplemented: false,
      botExecutionMode: config.botExecutionMode
    });
  }

  await validateDbConnection(config.database.url);
  console.log('connection succesfull');

  console.log('Bot runtime config loaded', redactSecrets({
    database: {
      hostName: config.database.hostName,
      port: config.database.port,
      userName: config.database.userName,
      dbName: config.database.dbName
    },
    exchangeA: config.exchangeA,
    exchangeB: config.exchangeB,
    symbol: config.btcSymbol,
    marketType: config.marketType,
    priceSource: config.priceSource,
    pricePollIntervalMs: config.pricePollIntervalMs,
    minPriceDiffUsd: config.minPriceDiffUsd,
    leverage: config.leverage,
    botExecutionMode: config.botExecutionMode,
    botRunOnce: config.botRunOnce,
    telegramEnabled: config.telegram.enabled,
    telegramAlertCooldownMs: config.telegram.alertCooldownMs,
    readApiEnabled: config.readApi.enabled
  }));

  console.log('Initializing exchange registry');
  const registry = createExchangeRegistry(config);
  const notifier = new TelegramNotifier(config.telegram);

  if (config.readApi.enabled) {
    console.log('Starting read-only API server', { host: config.readApi.host, port: config.readApi.port });
    createReadOnlyApiServer({ host: config.readApi.host, port: config.readApi.port });
  } else {
    console.log('Read-only API server disabled');
  }

  console.log('Starting monitoring loop');
  await runPollingLoop({ config, registry, notifier });
  console.log('Monitoring loop stopped', { stoppedAt: new Date().toISOString() });
}

main().catch((error: unknown) => {
  console.error('Bot stopped after fatal error', redactSecrets(error instanceof Error ? { message: error.message, stack: error.stack } : error));
  process.exitCode = 1;
});
