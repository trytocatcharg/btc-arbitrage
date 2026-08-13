import type { ExchangeBalance, ExchangeBalancesResponse } from '@btc-arbitrage/domain';
import type { BackendConfig } from '../config.js';
import { createErrorBalance, createUnconfiguredBalance, normalizeExtendedBalance, normalizeRisexBalance } from './balance-normalizers.js';
import { JsonHttpClient, type FetchLike } from './http-client.js';

export interface BalanceService {
  getRisexBalance(): Promise<ExchangeBalance>;
  getExtendedBalance(): Promise<ExchangeBalance>;
  getAllBalances(): Promise<ExchangeBalancesResponse>;
}

export function createBalanceService(config: BackendConfig, fetchImpl: FetchLike = fetch): BalanceService {
  const risexClient = new JsonHttpClient('RISEx', config.risex.apiBaseUrl, {}, fetchImpl);
  const extendedClient = new JsonHttpClient(
    'Extended',
    config.extended.apiBaseUrl,
    { 'user-agent': config.extended.userAgent },
    fetchImpl
  );

  return {
    async getRisexBalance(): Promise<ExchangeBalance> {
      if (!config.risex.accountAddress) {
        return createUnconfiguredBalance({
          exchangeId: 'risex',
          displayName: 'RISEx',
          message: 'RISEX_ACCOUNT_ADDRESS is required to read RISEx balances.'
        });
      }

      try {
        const payload = await risexClient.get('/v1/account/cross-margin-balance', {
          query: { account: config.risex.accountAddress }
        });
        return normalizeRisexBalance(payload);
      } catch (error) {
        return createErrorBalance({
          exchangeId: 'risex',
          displayName: 'RISEx',
          message: toPublicErrorMessage(error)
        });
      }
    },

    async getExtendedBalance(): Promise<ExchangeBalance> {
      if (!config.extended.apiKey) {
        return createUnconfiguredBalance({
          exchangeId: 'extended',
          displayName: 'Extended',
          message: 'EXTENDED_API_KEY is required to read Extended balances.'
        });
      }

      try {
        const payload = await extendedClient.get('/api/v1/user/balance', {
          headers: { 'x-api-key': config.extended.apiKey },
          zeroOn404: true
        });
        return normalizeExtendedBalance(payload);
      } catch (error) {
        return createErrorBalance({
          exchangeId: 'extended',
          displayName: 'Extended',
          message: toPublicErrorMessage(error)
        });
      }
    },

    async getAllBalances(): Promise<ExchangeBalancesResponse> {
      const [risex, extended] = await Promise.all([this.getRisexBalance(), this.getExtendedBalance()]);
      return {
        generatedAt: new Date().toISOString(),
        balances: [risex, extended]
      };
    }
  };
}

function toPublicErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown exchange balance error';
}
