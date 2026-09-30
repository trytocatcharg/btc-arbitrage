// HTTP client for Variational authenticated REST + public market data.
// Owns the cookie jar and the 401 -> re-login -> single-retry cycle.
// See docs/exchanges/variational.md.

import type { VariationalAuth } from "./variational-auth.js";
import type { VariationalConfig } from "./variational.types.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type VariationalJson =
  | string
  | number
  | boolean
  | null
  | VariationalJson[]
  | { [key: string]: VariationalJson };

// Mirrors the risex/extended clients: a hung exchange request must never
// freeze the bot's polling loop.
const REQUEST_TIMEOUT_MS = 10_000;

const FRONTEND_ORIGIN = "https://omni.variational.io";

interface AuthCookies {
  jwt: string;
  address: string;
}

/**
 * Minimal cookie jar scoped to the Variational hosts. Only name=value pairs
 * are kept; attributes (Path/HttpOnly/…) are ignored because all requests
 * target a single API base per purpose.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  storeFromHeaders(headers: Headers): void {
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name) this.cookies.set(name, decodeURIComponent(value));
    }
  }

  header(pairs: Record<string, string>): string {
    const merged = new Map(this.cookies);
    for (const [name, value] of Object.entries(pairs)) {
      merged.set(name, value);
    }
    return [...merged.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

export class VariationalHttpClient {
  private readonly jar = new CookieJar();

  constructor(
    private readonly config: VariationalConfig,
    private readonly auth: VariationalAuth,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Public market-data request (no auth). Base: priceApiBaseUrl. */
  async getPublic(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<VariationalJson> {
    let url: URL;
    try {
      url = new URL(`${this.config.priceApiBaseUrl}${path}`);
    } catch {
      throw new Error(
        `VARIATIONAL price API base URL is not valid: ${this.config.priceApiBaseUrl}`,
      );
    }
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: this.baseHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return this.parse("GET", path, response);
  }

  /** Authenticated GET. Base: apiBaseUrl. */
  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<VariationalJson> {
    return this.authedRequest("GET", path, undefined, query, true);
  }

  /** Authenticated POST. Base: apiBaseUrl. */
  async post(path: string, body: VariationalJson): Promise<VariationalJson> {
    return this.authedRequest("POST", path, body, {}, true);
  }

  private baseHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": this.config.userAgent,
      origin: FRONTEND_ORIGIN,
      referer: `${FRONTEND_ORIGIN}/`,
    };
  }

  private async authedRequest(
    method: "GET" | "POST",
    path: string,
    body: VariationalJson | undefined,
    query: Record<string, string | undefined>,
    allowReLogin: boolean,
  ): Promise<VariationalJson> {
    const session = await this.auth.getSession();
    const response = await this.send(method, path, body, query, session);
    if (response.status === 401 && allowReLogin) {
      // Session expired mid-flight: drop the cached JWT and retry exactly once.
      this.auth.clear();
      const fresh = await this.auth.getSession(true);
      const replay = await this.send(method, path, body, query, fresh);
      return this.parse(method, path, replay);
    }
    return this.parse(method, path, response);
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: VariationalJson | undefined,
    query: Record<string, string | undefined>,
    session: AuthCookies,
  ): Promise<Response> {
    let url: URL;
    try {
      url = new URL(`${this.config.apiBaseUrl}${path}`);
    } catch {
      throw new Error(
        `VARIATIONAL API base URL is not valid: ${this.config.apiBaseUrl}`,
      );
    }
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        ...this.baseHeaders(),
        "vr-connected-address": session.address,
        cookie: this.jar.header({
          "vr-token": session.jwt,
          "vr-connected-address": session.address,
        }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.jar.storeFromHeaders(response.headers);
    return response;
  }

  private async parse(
    method: "GET" | "POST",
    path: string,
    response: Response,
  ): Promise<VariationalJson> {
    const text = response.status === 204 ? "" : await response.text();
    const payload = parseResponseBody(text);
    if (!response.ok) {
      throw new Error(
        `Variational ${method} ${path} failed with HTTP ${response.status}: ` +
          extractErrorMessage(payload ?? null, text),
      );
    }
    return payload ?? null;
  }
}

// Variational error bodies: prefer error_message, then message, then raw.
function extractErrorMessage(
  payload: VariationalJson | undefined,
  rawText: string,
): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    const record = payload as Record<string, VariationalJson>;
    for (const key of ["error_message", "message", "raw"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return truncateForError(value);
      }
    }
  }
  if (typeof payload === "string" && payload.length > 0) {
    return truncateForError(payload);
  }
  return truncateForError(rawText) || "(empty error body)";
}

function parseResponseBody(text: string): VariationalJson | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as VariationalJson;
  } catch {
    return text;
  }
}

function truncateForError(value: string, maxLength = 400): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
