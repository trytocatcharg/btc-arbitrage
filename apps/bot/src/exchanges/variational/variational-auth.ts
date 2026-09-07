// SIWE (Sign-In with Ethereum) auth session for Variational.
// Flow: POST /auth/generate_signing_data -> personal_sign -> POST /auth/login.
// See docs/exchanges/variational.md and variational-bot/modules/core/variational_client.py.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  normalizePrivateKey,
  privateKeyToAddress,
} from "../risex/sdk/signing/helpers.js";
import type {
  VariationalConfig,
  VariationalSession,
} from "./variational.types.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const FRONTEND_ORIGIN = "https://omni.variational.io";

type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;

function personalSignHex(message: string, privateKey: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${messageBytes.length}`,
  );
  const digest = keccak_256(concatBytes(prefix, messageBytes));
  const signature = secp256k1.sign(
    digest,
    hexToBytes(normalizePrivateKey(privateKey)),
  );
  const v = Uint8Array.of(signature.recovery + 27);
  return bytesToHex(concatBytes(signature.toCompactRawBytes(), v));
}

export function deriveVariationalAddress(privateKey: string): string {
  return privateKeyToAddress(privateKey);
}

export interface VariationalAuth {
  /** Returns a valid session, logging in (or re-logging in) as needed. */
  getSession(force?: boolean): Promise<VariationalSession>;
  /** Drops the cached session so the next request re-authenticates. */
  clear(): void;
}

/**
 * SIWE auth session. Serializes concurrent logins via single-flight so
 * parallel callers never double-login.
 */
export class VariationalAuthSession implements VariationalAuth {
  private readonly address: string | undefined;
  private readonly privateKey: string | undefined;
  private session: VariationalSession | null = null;
  private loginPromise: Promise<VariationalSession> | null = null;

  constructor(
    private readonly config: VariationalConfig,
    private readonly fetchImpl: RawFetch = fetch,
  ) {
    this.privateKey = config.accountPrivateKey;
    this.address =
      config.accountAddress ??
      (config.accountPrivateKey
        ? deriveVariationalAddress(config.accountPrivateKey)
        : undefined);
  }

  get configured(): boolean {
    return Boolean(this.address && this.privateKey);
  }

  getSession(force = false): Promise<VariationalSession> {
    if (!this.configured) {
      return Promise.reject(
        new Error(
          "Variational auth is not configured: set VARIATIONAL_ACCOUNT_PRIVATE_KEY " +
            "(and optionally VARIATIONAL_ACCOUNT_ADDRESS).",
        ),
      );
    }
    if (
      !force &&
      this.session &&
      Date.now() - this.session.issuedAt < TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS
    ) {
      return Promise.resolve(this.session);
    }
    // Single-flight: concurrent callers share one in-flight login.
    this.loginPromise ??= this.login()
      .then((session) => {
        this.session = session;
        return session;
      })
      .finally(() => {
        this.loginPromise = null;
      });
    return this.loginPromise;
  }

  clear(): void {
    this.session = null;
  }

  private baseHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
      Origin: FRONTEND_ORIGIN,
      Referer: `${FRONTEND_ORIGIN}/`,
    };
  }

  private async rawRequest(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await response.json();
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { raw: String(parsed) };
    } catch {
      return { raw: await response.text().catch(() => "") };
    }
  }

  private extractJwt(
    body: Record<string, unknown>,
    response: Response,
  ): string {
    const token = body.token ?? body.jwt;
    if (typeof token === "string" && token.length > 0) return token;
    // Fallback: vr-token Set-Cookie.
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const [name, ...rest] = pair.split("=");
      if (name?.trim() === "vr-token")
        return decodeURIComponent(rest.join("=").trim());
    }
    throw new Error(
      "Variational login succeeded but no JWT found (body fields token/jwt and vr-token Set-Cookie were empty).",
    );
  }

  private async login(): Promise<VariationalSession> {
    const address = this.address as string;
    const privateKey = this.privateKey as string;

    // 1. Fetch SIWE signing message.
    const signingResponse = await this.rawRequest(
      "/auth/generate_signing_data",
      { address },
    );
    const signingBody = await this.readJson(signingResponse);
    if (!signingResponse.ok) {
      throw new Error(
        `Variational SIWE signing-data request failed with HTTP ${signingResponse.status}: ` +
          JSON.stringify(signingBody).slice(0, 300),
      );
    }
    const rawMessage = signingBody.message ?? signingBody.raw;
    if (typeof rawMessage !== "string" || rawMessage.length === 0) {
      throw new Error(
        `Variational SIWE response contained no message: ${JSON.stringify(signingBody).slice(0, 300)}`,
      );
    }

    // 2. personal_sign (hex signature without 0x prefix).
    const signature = personalSignHex(rawMessage, privateKey);

    // 3. Login, with referral-code retry handling.
    let loginBody: Record<string, unknown> = {
      address,
      signed_message: signature,
    };
    const referralCode = this.config.referralCode;
    if (referralCode) loginBody.code = referralCode;

    let loginResponse = await this.rawRequest("/auth/login", loginBody);
    let loginData = await this.readJson(loginResponse);

    const errorText = (data: Record<string, unknown>): string =>
      String(data.error_message ?? data.message ?? data.raw ?? "");

    if (loginResponse.status === 400 && referralCode) {
      if (
        errorText(loginData).includes(
          "Referee is already associated with a different referral code",
        )
      ) {
        // Wallet already bound to a referral code: retry without code.
        loginBody = { address, signed_message: signature };
        loginResponse = await this.rawRequest("/auth/login", loginBody);
        loginData = await this.readJson(loginResponse);
      }
    }

    if (!loginResponse.ok) {
      const message = errorText(loginData);
      if (
        loginResponse.status === 400 &&
        !referralCode &&
        message
          .toLowerCase()
          .includes("no existing referral code found for this user")
      ) {
        throw new Error(
          "Variational login failed: this wallet requires a referral code for first login. " +
            "Set VARIATIONAL_REFERRAL_CODE and retry.",
        );
      }
      throw new Error(
        `Variational login failed with HTTP ${loginResponse.status}: ${message || JSON.stringify(loginData).slice(0, 300)}`,
      );
    }

    const jwt = this.extractJwt(loginData, loginResponse);
    return { jwt, address, issuedAt: Date.now() };
  }
}
