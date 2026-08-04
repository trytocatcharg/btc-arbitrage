export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ArcusHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async get(path: string, query: Record<string, string | undefined> = {}, options: { private?: boolean } = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (options.private && this.apiKey) headers['x-api-key'] = this.apiKey;

    const response = await this.fetchImpl(url.toString(), { method: 'GET', headers });
    if (!response.ok) throw new Error(`Arcus GET ${path} failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
