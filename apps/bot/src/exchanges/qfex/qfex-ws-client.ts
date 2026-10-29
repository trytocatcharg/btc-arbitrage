import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { QfexConfig } from "./qfex.types.js";

/** Error raised for QFEX `err` frames and connection-level failures.
 * `errorCode` carries the exchange error_code (e.g. "RateLimited") when the
 * failure came from an `err` frame. */
export class QfexWsError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "QfexWsError";
  }
}

export interface QfexWsCorrelationKey {
  clientOrderId?: string;
  orderId?: string;
}

export interface QfexWsCommandOptions {
  /** Correlation token the response frame must carry (client_order_id or
   * order_id). The protocol has no request ids, so a command without a
   * correlation key resolves on the first response frame of its own type —
   * only safe for one-at-a-time commands of that type. */
  correlationKey?: QfexWsCorrelationKey;
  timeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
/** The exchange closes unauthenticated connections after 60 s; give up
 * well before that so a wedged auth surfaces as an error, not a hang. */
const AUTH_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

interface PendingCommand {
  type: string;
  params: Record<string, unknown>;
  correlationKey?: QfexWsCorrelationKey;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** QFEX trade WebSocket client (docs/exchanges/qfex.md). Single multiplexed
 * socket, lazy-connected on first command, HMAC auth within 60 s of connect,
 * request/response correlation by client_order_id / order_id (the protocol
 * has no request ids). Auto-reconnect with bounded backoff happens lazily:
 * a dropped socket rejects in-flight commands and the NEXT command
 * reconnects (re-auth + resubscribe). The secret key is used only to sign
 * and is never logged. */
export class QfexWsClient {
  private socket?: WebSocket;
  private state: "closed" | "connecting" | "ready" = "closed";
  private connectPromise?: Promise<void>;
  private readonly pending: PendingCommand[] = [];
  private readonly subscriptions = new Set<string>();
  private reconnectFailures = 0;
  private intentionalClose = false;

  constructor(private readonly config: QfexConfig) {}

  /** Send a command and resolve with the matching response frame payload
   * (the object under the frame's single top-level key, e.g. the
   * order_response object). Rejects with QfexWsError on `err` frames,
   * timeout, or connection loss. */
  async command(
    type: string,
    params: Record<string, unknown>,
    options: QfexWsCommandOptions = {},
  ): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || this.state !== "ready") {
      throw new QfexWsError(`QFEX websocket is not ready (state=${this.state})`);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropPending(entry);
        reject(
          new QfexWsError(
            `QFEX ws command ${type} timed out after ${options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS} ms`,
          ),
        );
      }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      const entry: PendingCommand = {
        type,
        params,
        correlationKey: options.correlationKey,
        resolve,
        reject,
        timer,
      };
      this.pending.push(entry);
      try {
        socket.send(JSON.stringify({ type, params }));
      } catch (error) {
        this.dropPending(entry);
        clearTimeout(timer);
        reject(
          new QfexWsError(
            `QFEX ws send failed for ${type}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /** Idempotent: tears the socket down and rejects in-flight commands. */
  close(): void {
    this.intentionalClose = true;
    this.state = "closed";
    const socket = this.socket;
    this.socket = undefined;
    this.rejectAllPending(new QfexWsError("QFEX websocket closed"));
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch {
        // Teardown must never throw.
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.state === "ready" && this.socket) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connect(): Promise<void> {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new QfexWsError(
        "QFEX_API_KEY and QFEX_SECRET_KEY are required for the QFEX trade websocket",
      );
    }
    // Bounded backoff across successive failed attempts (lazy reconnect:
    // the delay is paid by the first command after a drop, not by a
    // background timer, so an idle bot holds no socket).
    if (this.reconnectFailures > 0) {
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectFailures - 1),
        RECONNECT_MAX_DELAY_MS,
      );
      await new Promise((resolveSleep) => setTimeout(resolveSleep, delay));
    }
    this.state = "connecting";
    this.intentionalClose = false;
    const url = `${this.config.wsBaseUrl}?api_key=${encodeURIComponent(this.config.apiKey)}`;
    try {
      await this.openAndAuthenticate(url);
      this.state = "ready";
      this.reconnectFailures = 0;
      await this.resubscribe();
    } catch (error) {
      this.state = "closed";
      this.reconnectFailures += 1;
      // Tear the failed socket down: without this its listeners survive,
      // and when the exchange later closes the unauthenticated socket its
      // `close` event would hit handleSocketDrop and wipe a NEWER
      // connection's state.
      const failedSocket = this.socket;
      this.socket = undefined;
      if (failedSocket) {
        try {
          failedSocket.removeAllListeners();
          failedSocket.close();
        } catch {
          // Teardown must never throw.
        }
      }
      throw error;
    }
  }

  private openAndAuthenticate(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      const authTimer = setTimeout(() => {
        settle(() =>
          reject(
            new QfexWsError(
              `QFEX websocket auth did not complete within ${AUTH_TIMEOUT_MS} ms`,
            ),
          ),
        );
      }, AUTH_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        fn();
      };
      socket.on("open", () => {
        const nonce = randomBytes(16).toString("hex");
        const unixTs = Math.floor(Date.now() / 1000);
        const signature = createHmac("sha256", this.config.secretKey!)
          .update(`${nonce}:${unixTs}`)
          .digest("hex");
        socket.send(
          JSON.stringify({
            type: "auth",
            params: {
              hmac: {
                public_key: this.config.apiKey,
                nonce,
                unix_ts: unixTs,
                signature,
              },
              ...(this.config.accountId
                ? { account_id: this.config.accountId }
                : {}),
            },
          }),
        );
      });
      socket.on("message", (data: WebSocket.RawData) => {
        if (this.socket !== socket) return; // stale socket, ignore
        const frame = parseFrame(data);
        if (frame === undefined) return;
        if (!settled) {
          if (frame.authenticated === true) {
            settle(resolve);
            return;
          }
          if (isRecord(frame.err)) {
            const err = frame.err;
            settle(() =>
              reject(
                new QfexWsError(
                  `QFEX websocket auth rejected: ${describeErr(err)}`,
                  typeof err.error_code === "string"
                    ? err.error_code
                    : undefined,
                ),
              ),
            );
            return;
          }
          // Ignore any other pre-auth frame.
          return;
        }
        this.dispatch(frame);
      });
      socket.on("error", (error: Error) => {
        if (this.socket !== socket) return; // stale socket, ignore
        settle(() =>
          reject(
            new QfexWsError(`QFEX websocket error: ${error.message}`),
          ),
        );
      });
      socket.on("close", (code: number, reason: Buffer) => {
        if (this.socket !== socket) return; // stale socket, ignore
        if (!settled) {
          settle(() =>
            reject(
              new QfexWsError(
                `QFEX websocket closed during auth (code=${code} ${reason.toString("utf8")})`,
              ),
            ),
          );
          return;
        }
        this.handleSocketDrop(
          new QfexWsError(
            `QFEX websocket connection lost (code=${code} ${reason.toString("utf8")})`,
          ),
        );
      });
    });
  }

  private handleSocketDrop(error: QfexWsError): void {
    if (this.state !== "ready" && this.state !== "connecting") return;
    this.state = "closed";
    this.socket = undefined;
    this.rejectAllPending(error);
    if (!this.intentionalClose) {
      // Lazy reconnect: the next command() re-dials with backoff. No
      // background timer — an idle bot holds no half-open socket.
      console.warn("QFEX websocket dropped; next command will reconnect", {
        message: error.message,
      });
    }
  }

  private async resubscribe(): Promise<void> {
    // The adapter subscribes to nothing today (commands only); the set is
    // kept so a future subscription survives reconnects.
    for (const channel of this.subscriptions) {
      this.socket?.send(
        JSON.stringify({ type: "subscribe", params: { channels: [channel] } }),
      );
    }
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (isRecord(frame.err)) {
      this.dispatchErr(frame.err);
      return;
    }
    if (isRecord(frame.order_response)) {
      const response = frame.order_response;
      const clientOrderId =
        typeof response.client_order_id === "string"
          ? response.client_order_id
          : undefined;
      const orderId =
        typeof response.order_id === "string" ? response.order_id : undefined;
      this.resolvePending(
        (entry) =>
          matchesKey(entry.correlationKey?.clientOrderId, clientOrderId) ||
          matchesKey(entry.correlationKey?.orderId, orderId),
        response,
      );
      return;
    }
    if (isRecord(frame.stop_order_response)) {
      const response = frame.stop_order_response;
      const clientOrderId =
        typeof response.client_order_id === "string"
          ? response.client_order_id
          : undefined;
      const stopOrderId =
        typeof response.stop_order_id === "string"
          ? response.stop_order_id
          : undefined;
      this.resolvePending(
        (entry) =>
          matchesKey(entry.correlationKey?.clientOrderId, clientOrderId) ||
          // cancel_stop_order correlates by stop_order_id (the command
          // carries no client_order_id).
          matchesKey(entry.correlationKey?.orderId, stopOrderId),
        response,
      );
      return;
    }
    if (Array.isArray(frame.user_trades_response)) {
      const trades = frame.user_trades_response;
      // get_user_trades answers with a bare array (no correlation token),
      // so match the pending command whose own params.order_id appears in
      // the returned trades; an empty array or unmatched filter falls
      // back to single-in-flight elimination.
      const matched = this.pending.find((entry) => {
        if (entry.type !== "get_user_trades") return false;
        const wanted =
          typeof entry.params.order_id === "string"
            ? entry.params.order_id
            : undefined;
        return (
          wanted !== undefined &&
          trades.some((row) => isRecord(row) && row.order_id === wanted)
        );
      });
      const candidates = this.pending.filter(
        (entry) => entry.type === "get_user_trades",
      );
      const entry =
        matched ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (entry) {
        this.dropPending(entry);
        entry.resolve(trades);
      }
      return;
    }
    if (isRecord(frame.ack)) {
      const ack = frame.ack;
      // ack echoes the acked message in incoming_message; match like err
      // frames do: correlation-token substring in the echo → type match
      // when exactly one in-flight command has that type →
      // single-in-flight elimination. Exact params equality is NOT used
      // (the echo's key order is not guaranteed).
      const echoed = ack.incoming_message;
      const echoedText =
        echoed === undefined
          ? undefined
          : typeof echoed === "string"
            ? echoed
            : JSON.stringify(echoed);
      const echoedType =
        isRecord(echoed) && typeof echoed.type === "string"
          ? echoed.type
          : undefined;
      let entry: PendingCommand | undefined;
      if (echoedText !== undefined) {
        entry = this.pending.find((candidate) => {
          const tokens = [
            candidate.correlationKey?.clientOrderId,
            candidate.correlationKey?.orderId,
          ].filter((token): token is string => Boolean(token));
          return tokens.some((token) => echoedText.includes(token));
        });
        if (!entry && echoedType !== undefined) {
          const ofType = this.pending.filter(
            (candidate) => candidate.type === echoedType,
          );
          if (ofType.length === 1) entry = ofType[0];
        }
      }
      entry ??= this.pending.length === 1 ? this.pending[0] : undefined;
      if (entry) {
        this.dropPending(entry);
        entry.resolve(ack);
      } else {
        console.warn("QFEX ws ack frame matched no pending command", {
          echoedType,
        });
      }
      return;
    }
    // Subscription pushes (position/balance/fill updates) and unknown
    // frames: the adapter consumes nothing here — ignore.
  }

  private dispatchErr(err: Record<string, unknown>): void {
    const errorCode =
      typeof err.error_code === "string" ? err.error_code : "unknown";
    const message = typeof err.message === "string" ? err.message : undefined;
    const error = new QfexWsError(
      `QFEX ws error ${errorCode}: ${message ?? "no message"}`,
      errorCode,
    );
    const echoed =
      err.incoming_message === undefined
        ? undefined
        : typeof err.incoming_message === "string"
          ? err.incoming_message
          : JSON.stringify(err.incoming_message);
    // The err frame echoes the offending message; match pendings whose
    // correlation token appears in the echo. When the echo is unusable and
    // exactly one command is in flight, that one owns the error.
    const matched = this.pending.filter((entry) => {
      if (echoed !== undefined) {
        const tokens = [
          entry.correlationKey?.clientOrderId,
          entry.correlationKey?.orderId,
        ].filter((token): token is string => Boolean(token));
        if (tokens.some((token) => echoed.includes(token))) return true;
        // Type match only when exactly one in-flight command has that
        // type — otherwise concurrent same-type commands would be
        // cross-rejected; unmatched errs warn like the no-match path.
        const ofType = this.pending.filter(
          (candidate) => candidate.type === entry.type,
        );
        if (ofType.length === 1 && echoed.includes(`"${entry.type}"`))
          return true;
      }
      return false;
    });
    const targets =
      matched.length > 0
        ? matched
        : this.pending.length === 1
          ? [...this.pending]
          : [];
    if (targets.length === 0) {
      console.warn("QFEX ws err frame matched no pending command", {
        errorCode,
        message,
      });
      return;
    }
    for (const entry of targets) {
      this.dropPending(entry);
      entry.reject(error);
    }
  }

  private resolvePending(
    predicate: (entry: PendingCommand) => boolean,
    payload: unknown,
  ): void {
    const entry = this.pending.find(predicate);
    if (!entry) return; // Async update without a waiting command.
    this.dropPending(entry);
    entry.resolve(payload);
  }

  private dropPending(entry: PendingCommand): void {
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
    clearTimeout(entry.timer);
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

function parseFrame(data: WebSocket.RawData): Record<string, unknown> | undefined {
  let text: string;
  if (typeof data === "string") text = data;
  else if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else if (Array.isArray(data)) text = Buffer.concat(data).toString("utf8");
  else text = Buffer.from(data).toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    console.warn("QFEX ws frame was not valid JSON; ignored", {
      preview: text.slice(0, 200),
    });
    return undefined;
  }
}

function matchesKey(expected: string | undefined, actual: string | undefined): boolean {
  return expected !== undefined && actual !== undefined && expected === actual;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeErr(err: Record<string, unknown>): string {
  const code = typeof err.error_code === "string" ? err.error_code : "unknown";
  const message = typeof err.message === "string" ? err.message : "no message";
  return `${code}: ${message}`;
}
