import { createHmac, randomBytes } from "node:crypto";
import type { QfexConfig } from "./qfex.types.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Same discipline as the Extended client: hung exchange requests must not
// freeze the polling loop — every request aborts after 10 s.
const REQUEST_TIMEOUT_MS = 10_000;

export interface QfexHttpRequestOptions {
  private?: boolean;
  query?: Record<
    string,
    string | number | boolean | Array<string | number | boolean> | undefined
  >;
}

/** QFEX REST client. Public market-data GETs are unauthenticated; private
 * GET/POST sign with the API-key HMAC scheme (docs/exchanges/qfex.md):
 *   x-qfex-public-key:      public API key
 *   x-qfex-nonce:           fresh random hex (unique per 15 min window)
 *   x-qfex-timestamp:       unix seconds
 *   x-qfex-hmac-signature:  hex HMAC-SHA256(secret, `${nonce}:${timestamp}`)
 *   x-qfex-requested-account-id: optional subaccount UUID
 * The secret never appears in logs: errors carry method/path/status and a
 * truncated body only. */
export class QfexHttpClient {
  constructor(
    private readonly config: QfexConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async get(
    path: string,
    options: QfexHttpRequestOptions = {},
  ): Promise<unknown> {
    return this.request("GET", path, undefined, options);
  }

  async post(
    path: string,
    body: unknown,
    options: QfexHttpRequestOptions = {},
  ): Promise<unknown> {
    return this.request("POST", path, body, options);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    options: QfexHttpRequestOptions,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.config.userAgent,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.private) {
      if (!this.config.apiKey || !this.config.secretKey) {
        throw new Error(
          "QFEX_API_KEY and QFEX_SECRET_KEY are required for QFEX private REST requests",
        );
      }
      const nonce = randomBytes(16).toString("hex");
      const timestamp = Math.floor(Date.now() / 1000).toString(10);
      const signature = createHmac("sha256", this.config.secretKey)
        .update(`${nonce}:${timestamp}`)
        .digest("hex");
      headers["x-qfex-public-key"] = this.config.apiKey;
      headers["x-qfex-nonce"] = nonce;
      headers["x-qfex-timestamp"] = timestamp;
      headers["x-qfex-hmac-signature"] = signature;
      if (this.config.accountId) {
        headers["x-qfex-requested-account-id"] = this.config.accountId;
      }
    }
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        const timeoutError = new Error(
          `QFEX ${method} ${path} timed out after ` +
            `${Date.now() - startedAt} ms (budget ${REQUEST_TIMEOUT_MS} ms)`,
        );
        // Named so the bot's startup preflight retry (main.ts
        // isTransientPreflightError) recognizes it as transient.
        timeoutError.name = "QfexRequestTimeoutError";
        throw timeoutError;
      }
      throw error;
    }
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok) {
      throw new Error(
        `QFEX ${method} ${path} failed with HTTP ${response.status}${text ? `: ${truncateForError(text)}` : ""}`,
      );
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `QFEX ${method} ${path} returned a non-JSON body: ${truncateForError(text)}`,
      );
    }
  }

  private url(path: string, query?: QfexHttpRequestOptions["query"]): string {
    let url: URL;
    try {
      url = new URL(`${this.config.apiBaseUrl}${path}`);
    } catch {
      throw new Error(
        `QFEX_API_BASE_URL is not a valid URL: ${this.config.apiBaseUrl}`,
      );
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) url.searchParams.append(key, String(item));
    }
    return url.toString();
  }
}

function truncateForError(value: string, maxLength = 400): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
