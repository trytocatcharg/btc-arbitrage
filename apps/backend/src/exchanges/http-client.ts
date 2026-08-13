export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ExchangeHttpError extends Error {
  constructor(
    readonly exchangeName: string,
    readonly path: string,
    readonly status: number
  ) {
    super(`${exchangeName} GET ${path} failed with HTTP ${status}`);
  }
}

export class JsonHttpClient {
  constructor(
    private readonly exchangeName: string,
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  async get(path: string, options: { query?: Record<string, string | undefined>; headers?: Record<string, string>; zeroOn404?: boolean } = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        signal: abortController.signal,
        headers: {
          accept: 'application/json',
          ...this.defaultHeaders,
          ...options.headers
        }
      });

      if (response.status === 404 && options.zeroOn404) {
        return { syntheticZeroBalance: true };
      }

      if (!response.ok) throw new ExchangeHttpError(this.exchangeName, path, response.status);
      return response.json() as Promise<unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
}
