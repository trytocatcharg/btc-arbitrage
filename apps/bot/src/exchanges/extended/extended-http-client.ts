export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ExtendedHttpClient {
  constructor(private readonly baseUrl: string, private readonly userAgent: string, private readonly apiKey?: string, private readonly fetchImpl: FetchLike = fetch) {}

  async get(path: string, options: { private?: boolean } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (options.private && this.apiKey) headers['x-api-key'] = this.apiKey;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers });
    if (response.status === 404 && path === '/api/v1/user/balance') return { balance: '0', syntheticZeroBalance: true };
    if (!response.ok) throw new Error(`Extended GET ${path} failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
