import { loadBotConfig, loadDotEnvFile, redactSecrets } from '@btc-arbitrage/config';
import { getDb, validateDbConnection } from '@btc-arbitrage/db';
import { createExchangeRegistry } from './exchanges/registry.js';
import { TelegramCommandPoller } from './notifications/telegram-command-poller.js';
import { TelegramNotifier } from './notifications/telegram-notifier.js';
import { runPollingLoop } from './runtime/polling-loop.js';

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

  console.log('Bot runtime config loaded', redactSecrets({
    database: {
      hostName: config.database.hostName,
      port: config.database.port,
      userName: config.database.userName,
      dbName: config.database.dbName,
      url: config.database.url
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
    telegramAlertCooldownMs: config.telegram.alertCooldownMs
  }));


  console.log('Connecting to database...');
  await getDb();
  console.log('Database connected');
  // await validateDbConnection(config.database.url);
  // console.log('connection succesfull');


  console.log('Initializing exchange registry');
  const registry = createExchangeRegistry(config);
  const notifier = new TelegramNotifier(config.telegram);
  const commandPoller = config.telegram.enabled ? new TelegramCommandPoller(config) : undefined;
  if (commandPoller) {
    try {
      await commandPoller.configureAvailableCommands();
      console.log('Telegram commands configured', {
        scope: 'chat',
        commands: ['config']
      });
    } catch (error) {
      console.warn('Telegram command configuration failed; monitoring will continue', error instanceof Error ? { message: error.message } : { error });
    }
  }

  console.log('Starting monitoring loop');
  await runPollingLoop({ config, registry, notifier, commandPoller });
  console.log('Monitoring loop stopped', { stoppedAt: new Date().toISOString() });
}

main().catch((error: unknown) => {
  console.error('Bot stopped after fatal error', redactSecrets(error instanceof Error ? { message: error.message, stack: error.stack } : error));
  process.exitCode = 1;
});
