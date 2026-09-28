export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// 2026-09-28: hung exchange requests froze the bot's polling loop forever
// (no timeout anywhere); every request now aborts after 10 s.
const REQUEST_TIMEOUT_MS = 10_000;

export class ArcusHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async get(path: string, query: Record<string, string | undefined> = {}, options: { private?: boolean } = {}): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(`${this.baseUrl}${path}`);
    } catch {
      throw new Error(`Arcus API base URL is not valid: ${this.baseUrl}`);
    }
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (options.private && this.apiKey) headers['x-api-key'] = this.apiKey;

    const response = await this.fetchImpl(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Arcus GET ${path} failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
