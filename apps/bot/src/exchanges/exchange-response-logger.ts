import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@btc-arbitrage/config";

/** Raw exchange responses for fee analysis, one JSON line per record, in
 * `<repoRoot>/logs/exchange-responses.jsonl` (override with
 * EXCHANGE_RESPONSE_LOG_PATH). Events:
 * - order_submit: ack when an entry/hedge order is placed
 * - tpsl_place: ack when a TP/SL trigger order is placed
 * - order_read: single-order read that carried fill/terminal state
 * - market_fill_read: fill price/fee recovery while opening (hedge)
 * - position_read: position poll that reported a close or exit data
 * - closure_tpsl_read: /v1/orders/tpsl during closure resolution
 * - closure_order_history_read: /v1/orders or /v1/trade-history during
 *   closure resolution
 * - closure_order_read: per-order read during closure resolution */
export type ExchangeResponseEvent =
  | "order_submit"
  | "tpsl_place"
  | "order_read"
  | "market_fill_read"
  | "position_read"
  | "closure_tpsl_read"
  | "closure_order_history_read"
  | "closure_order_read";

export interface ExchangeResponseLogInput {
  exchange: string;
  event: ExchangeResponseEvent;
  context?: Record<string, unknown>;
  response: unknown;
}

let cachedLogPath: string | null | undefined;

/** Resolve once per process: EXCHANGE_RESPONSE_LOG_PATH, else
 * <repoRoot>/logs/exchange-responses.jsonl. The repo root is found by
 * walking up from cwd to the directory holding yarn.lock, so the log
 * lands at the project root whether the bot starts from the repo or from
 * apps/bot. */
function resolveLogPath(): string | null {
  if (cachedLogPath !== undefined) return cachedLogPath;
  const configured = process.env.EXCHANGE_RESPONSE_LOG_PATH?.trim();
  if (configured) {
    cachedLogPath = path.isAbsolute(configured)
      ? configured
      : path.join(process.cwd(), configured);
    return cachedLogPath;
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, "yarn.lock"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = process.cwd();
      break;
    }
    dir = parent;
  }
  cachedLogPath = path.join(dir, "logs", "exchange-responses.jsonl");
  return cachedLogPath;
}

/** Append one redacted record. Fire-and-forget: logging must never delay,
 * reorder, or break a trade path. Failures surface as a console warning. */
export function logExchangeResponse(input: ExchangeResponseLogInput): void {
  const filePath = resolveLogPath();
  if (!filePath) return;
  const record = {
    ts: new Date().toISOString(),
    exchange: input.exchange,
    event: input.event,
    ...(input.context ? { context: redactSecrets(input.context) } : {}),
    response: redactSecrets(input.response),
  };
  void mkdir(path.dirname(filePath), { recursive: true })
    .then(() =>
      appendFile(filePath, `${JSON.stringify(record)}\n`, { flag: "a" }),
    )
    .catch((error) => {
      console.warn("Exchange response log write failed", {
        path: filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}
