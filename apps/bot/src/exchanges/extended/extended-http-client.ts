import { JsonFileLogger } from '../../logging/json-file-logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExtendedHttpRequestOptions {
  private?: boolean;
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
}

export class ExtendedHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger = new JsonFileLogger('logs/extended-http.jsonl')
  ) {}

  async get(path: string, options: ExtendedHttpRequestOptions = {}): Promise<unknown> {
    return this.request('GET', path, undefined, options);
  }

  async post(path: string, body: unknown, options: ExtendedHttpRequestOptions = {}): Promise<unknown> {
    return this.request('POST', path, body, options);
  }

  async delete(path: string, options: ExtendedHttpRequestOptions = {}): Promise<unknown> {
    return this.request('DELETE', path, undefined, options);
  }

  private async request(method: string, path: string, body: unknown, options: ExtendedHttpRequestOptions): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.private) {
      if (!this.apiKey) throw new Error('EXTENDED_API_KEY is required for Extended private REST requests');
      headers['x-api-key'] = this.apiKey;
    }
    const response = await this.fetchImpl(this.url(path, options.query), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = response.status === 204 ? '' : await response.text();
    const payload = parseResponseBody(text);
    await this.logger.write({
      timestamp: new Date().toISOString(),
      event: 'extended_http_response',
      method,
      path,
      query: options.query,
      private: options.private === true,
      status: response.status,
      ok: response.ok,
      body: payload
    });
    if (response.status === 404 && method === 'GET' && path === '/api/v1/user/balance') return { syntheticZeroBalance: true };
    if (!response.ok) throw new Error(`Extended ${method} ${path} failed with HTTP ${response.status}${text ? `: ${truncateForError(text)}` : ''}`);
    if (response.status === 204) return undefined;
    return payload;
  }

  private url(path: string, query?: ExtendedHttpRequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) url.searchParams.append(key, String(item));
    }
    return url.toString();
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function truncateForError(value: string, maxLength = 400): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
