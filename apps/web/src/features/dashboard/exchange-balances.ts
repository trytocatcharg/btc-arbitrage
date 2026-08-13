import type { ExchangeBalance, ExchangeBalancesResponse, ExchangeId } from '@btc-arbitrage/domain';

const DEFAULT_BACKEND_API_BASE_URL = 'http://127.0.0.1:3002';

export interface ExchangeBalancesState {
  balances: ExchangeBalance[];
  generatedAt?: string;
  loading: boolean;
  error?: string;
}

export async function fetchExchangeBalances(fetchImpl: typeof fetch = fetch): Promise<ExchangeBalancesResponse> {
  const baseUrl = getBackendApiBaseUrl();
  const response = await fetchImpl(`${baseUrl}/api/exchanges/balances`, {
    method: 'GET',
    headers: { accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Backend balances request failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<ExchangeBalancesResponse>;
}

export function findExchangeBalance(balances: ExchangeBalance[], exchangeId: ExchangeId): ExchangeBalance | undefined {
  return balances.find((balance) => balance.exchangeId === exchangeId);
}

function getBackendApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_BACKEND_API_BASE_URL?.trim();
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/$/, '');

  if (typeof window === 'undefined') return DEFAULT_BACKEND_API_BASE_URL;

  const url = new URL(window.location.href);
  url.port = '3002';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
