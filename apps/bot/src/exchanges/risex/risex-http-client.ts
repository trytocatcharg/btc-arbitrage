import { JsonFileLogger } from '../../logging/json-file-logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class RisexHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger = new JsonFileLogger('logs/risex-http.jsonl')
  ) {}

  async get(path: string, query: Record<string, string | undefined> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    return this.parseAndLog('GET', path, response, query);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return this.parseAndLog('POST', path, response);
  }

  private async parseAndLog(method: 'GET' | 'POST', path: string, response: Response, query?: Record<string, string | undefined>): Promise<unknown> {
    const text = await response.text();
    const payload = parseResponseBody(text);
    await this.logger.write({
      timestamp: new Date().toISOString(),
      event: 'risex_http_response',
      method,
      path,
      query,
      status: response.status,
      ok: response.ok,
      body: payload
    });
    if (!response.ok) {
      throw new Error(`RISEx ${method} ${path} failed with HTTP ${response.status}${text ? `: ${truncateForError(text)}` : ''}`);
    }
    return payload;
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
