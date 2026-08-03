export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class RisexHttpClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike = fetch) {}

  async get(path: string, query: Record<string, string | undefined> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`RISEx GET ${path} failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
