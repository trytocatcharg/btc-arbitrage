import { loadDotEnvFile, redactSecrets } from '@btc-arbitrage/config';
import { loadBackendConfig } from './config.js';
import { createBalanceService } from './exchanges/balance-service.js';
import { createBackendApp } from './server.js';

async function main() {
  console.log('BTC Arbitrage backend starting', {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    startedAt: new Date().toISOString()
  });

  const loadedEnvPath = loadDotEnvFile();
  console.log('Environment file status', { loaded: Boolean(loadedEnvPath), path: loadedEnvPath ?? null });

  const config = loadBackendConfig();
  console.log('Backend config loaded', redactSecrets({
    host: config.host,
    port: config.port,
    corsAllowedOrigins: config.corsAllowedOrigins,
    risex: {
      apiBaseUrl: config.risex.apiBaseUrl,
      accountAddressConfigured: Boolean(config.risex.accountAddress),
      accountPrivateKeyConfigured: Boolean(config.risex.accountPrivateKey),
      sessionSignerPrivateKeyConfigured: Boolean(config.risex.sessionSignerPrivateKey)
    },
    extended: {
      apiBaseUrl: config.extended.apiBaseUrl,
      apiKeyConfigured: Boolean(config.extended.apiKey),
      userAgent: config.extended.userAgent
    }
  }));

  const app = createBackendApp(config, createBalanceService(config));
  app.listen(config.port, config.host, () => {
    console.log(`Backend API listening at http://${config.host}:${config.port}`);
  });
}

main().catch((error: unknown) => {
  console.error('Backend stopped after fatal error', redactSecrets(error instanceof Error ? { message: error.message, stack: error.stack } : error));
  process.exitCode = 1;
});
