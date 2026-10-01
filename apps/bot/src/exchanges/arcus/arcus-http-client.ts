export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// 2026-09-28: hung exchange requests froze the bot's polling loop forever
// (no timeout anywhere); every request now aborts after 10 s.
const REQUEST_TIMEOUT_MS = 10_000;

/** HTTP error carrying the response status so callers can branch on it
 * (e.g. Arcus GET /v1/account returns 404 until the first deposit). The
 * message keeps the historical "HTTP {status}" shape for GETs. */
export class ArcusHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText?: string,
  ) {
    super(message);
    this.name = "ArcusHttpError";
  }
}

export interface ArcusRequestSignature {
  /** Unix nanoseconds as a decimal string — must equal the signed payload's
   * ct / the legacy message timestamp. */
  timestampNs: string;
  /** Ed25519 signature hex (128 chars). Never logged. */
  signature: string;
}

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
    if (!response.ok) throw new ArcusHttpError(`Arcus GET ${path} failed with HTTP ${response.status}`, response.status);
    return response.json() as Promise<unknown>;
  }

  /** Signed (or unsigned) JSON POST. When `signature` is present the
   * request carries the Arcus authenticated-order headers (X-API-Key is the
   * hex Ed25519 public key; X-Timestamp is Unix ns; X-Signature is the
   * Ed25519 signature over the payload). Headers and bodies are never
   * logged — they carry secrets. */
  async post(
    path: string,
    body: unknown,
    options: {
      query?: Record<string, string | undefined>;
      signature?: ArcusRequestSignature;
    } = {}
  ): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(`${this.baseUrl}${path}`);
    } catch {
      throw new Error(`Arcus API base URL is not valid: ${this.baseUrl}`);
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': this.userAgent,
    };
    if (options.signature) {
      if (!this.apiKey)
        throw new Error('Arcus API key is required for signed POST requests');
      headers['X-API-Key'] = this.apiKey;
      headers['X-Timestamp'] = options.signature.timestampNs;
      headers['X-Signature'] = options.signature.signature;
    }

    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Arcus returns useful error strings; surface the parsed message (or
      // the raw body) so rejections like POST_ONLY_WOULD_CROSS reach the
      // retry logic in the trade executor.
      const bodyText = await response.text().catch(() => '');
      const detail = extractErrorDetail(bodyText);
      throw new ArcusHttpError(
        `Arcus POST ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        bodyText,
      );
    }
    return response.json() as Promise<unknown>;
  }
}

function extractErrorDetail(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'error', 'errorMessage', 'reason']) {
        const value = record[key];
        if (typeof value === 'string' && value) return value;
      }
    }
  } catch {
    // Not JSON: fall through to the raw body snippet.
  }
  return bodyText.slice(0, 500);
}
