/**
 * ORBIT Perp Screener (orbitperpscreener.com/arbitrage) — read-only client.
 *
 * The arbitrage page is a Next.js app WITHOUT a public JSON API: every
 * `/api/arbitrage`-style route returns 404. The full table payload (all
 * assets, every venue's mark price) is embedded in the server-rendered
 * HTML as escaped JSON inside the `self.__next_f.push(...)` flight
 * chunks. This client fetches the page once per command invocation and
 * extracts that embedded payload; the URL query params (ex/class/sort)
 * are client-side filters, so they are replicated here in code instead.
 *
 * The spread is recomputed across ONLY the selected exchanges — exactly
 * what the site shows when the exchange picker is limited — so the
 * result matches the operator's saved view:
 *   ?ex=arcus,extended,qfex,risex&class=tradfi&sort=spread&dir=desc
 *
 * Read-only: never sends credentials, never mutates anything.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OrbitScreenerConfig {
  /** Base origin of the screener site. */
  baseUrl: string;
  /** Exchange slugs the spread is computed across (site `ex` param). */
  exchanges: string[];
  /** Asset class filter: "tradfi" or "all" (site `class` param). */
  assetClass: "tradfi" | "all";
  /** How many top rows to report. */
  topN: number;
  /** HTTP timeout for the page fetch (the HTML is ~4 MB). */
  timeoutMs: number;
}

export interface ArbitrageTopRow {
  symbol: string;
  spreadPct: number;
  longExchange: string;
  longPrice: number;
  shortExchange: string;
  shortPrice: number;
}

interface OrbitCell {
  markPrice?: number;
  exchangeTicker?: string;
  ts?: string;
  ageSeconds?: number;
  alignState?: string;
}

interface OrbitRow {
  symbol?: string;
  isTradFi?: boolean;
  cells?: Record<string, OrbitCell>;
}

interface OrbitArbitragePayload {
  updatedAt?: string;
  totalCount?: number;
  rows?: OrbitRow[];
}

export interface OrbitArbitrageResult {
  updatedAt: string | null;
  totalCount: number | null;
  /** Rows that had a mark price on at least 2 of the selected exchanges. */
  evaluatedCount: number;
  rows: ArbitrageTopRow[];
}

const DEFAULT_BASE_URL = "https://orbitperpscreener.com";
const DEFAULT_EXCHANGES = "arcus,extended,qfex,risex";
const DEFAULT_TIMEOUT_MS = 15_000;

export function loadOrbitScreenerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrbitScreenerConfig {
  return {
    baseUrl: (env.ORBIT_SCREENER_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    exchanges: (env.ORBIT_SCREENER_EXCHANGES ?? DEFAULT_EXCHANGES)
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
    assetClass: env.ORBIT_SCREENER_ASSET_CLASS === "all" ? "all" : "tradfi",
    topN: clampTopN(Number(env.ORBIT_SCREENER_TOP_N ?? 5)),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function clampTopN(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 5;
  return Math.min(value, 20);
}

/**
 * Fetches the arbitrage page and returns the top cross-exchange spreads
 * across the configured exchanges. Throws with an operator-readable
 * message on any failure (network, HTML shape drift, payload missing).
 */
export async function fetchOrbitArbitrageTop(
  fetchImpl: FetchLike,
  config: OrbitScreenerConfig,
): Promise<OrbitArbitrageResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.baseUrl}/arbitrage`,
      // AbortSignal.timeout needs a DOM/Node lib that ships it (Node >= 17);
      // guarded so a bare fetch stub in tests keeps working.
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? { signal: AbortSignal.timeout(config.timeoutMs) }
        : undefined,
    );
  } catch (error) {
    // Telegram surfaces this message verbatim: keep it operator-readable
    // instead of the raw fetch failure ("fetch failed", ENOTFOUND, …).
    throw new Error(
      `Could not reach the ORBIT screener (${config.baseUrl}): ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `ORBIT screener returned HTTP ${response.status} for /arbitrage`,
    );
  }
  const html = await response.text();
  const payload = extractEmbeddedPayload(html);
  const rows = selectTopRows(payload.rows ?? [], config);
  return {
    updatedAt: payload.updatedAt ?? null,
    totalCount: payload.totalCount ?? null,
    evaluatedCount: rows.evaluatedCount,
    rows: rows.top,
  };
}

/**
 * Extracts the arbitrage payload object embedded in the Next.js flight
 * chunks of the SSR HTML. The payload is escaped as a JS string literal
 * (`\"` for quotes), so the raw slice is unescaped by parsing it as a
 * JSON string, then parsed as JSON.
 *
 * Shape-drift guard: if the site ever stops embedding the table (e.g.
 * moves to a client-only fetch), the markers vanish and this throws
 * instead of returning stale/garbage data.
 */
export function extractEmbeddedPayload(html: string): OrbitArbitragePayload {
  const marker = '\\"rows\\":[';
  const rowsIndex = html.indexOf(marker);
  if (rowsIndex < 0) {
    throw new Error(
      "ORBIT screener: embedded arbitrage payload not found (site layout changed?)",
    );
  }

  // Walk backwards from the rows marker to the "{" that opens the object
  // containing it (balance counter: "}" opens depth, "{" closes it).
  let depth = 0;
  let start = -1;
  for (let i = rowsIndex; i >= 0; i--) {
    const ch = html[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) {
    throw new Error("ORBIT screener: could not locate payload start");
  }

  // Walk forwards to the matching closing brace.
  depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("ORBIT screener: could not locate payload end");
  }

  const raw = html.slice(start, end + 1);
  let unescaped: string;
  try {
    unescaped = JSON.parse(`"${raw}"`) as string;
  } catch {
    throw new Error("ORBIT screener: failed to unescape embedded payload");
  }
  try {
    return JSON.parse(unescaped) as OrbitArbitragePayload;
  } catch {
    throw new Error("ORBIT screener: embedded payload is not valid JSON");
  }
}

/**
 * Replicates the site's view for the configured filters: keeps assets of
 * the requested class, computes the spread across ONLY the selected
 * exchanges (max vs min mark price, as % of the min), keeps assets
 * priced on at least 2 venues, sorts descending and takes the top N.
 */
export function selectTopRows(
  rows: OrbitRow[],
  config: Pick<OrbitScreenerConfig, "exchanges" | "assetClass" | "topN">,
): { evaluatedCount: number; top: ArbitrageTopRow[] } {
  const evaluated: ArbitrageTopRow[] = [];
  for (const row of rows) {
    const entry = evaluateRow(row, config);
    if (entry) evaluated.push(entry);
  }
  evaluated.sort((a, b) => b.spreadPct - a.spreadPct);
  return {
    evaluatedCount: evaluated.length,
    top: evaluated.slice(0, config.topN),
  };
}

function evaluateRow(
  row: OrbitRow,
  config: Pick<OrbitScreenerConfig, "exchanges" | "assetClass">,
): ArbitrageTopRow | null {
  if (typeof row.symbol !== "string" || row.symbol.length === 0) return null;
  if (config.assetClass === "tradfi" && row.isTradFi !== true) return null;
  const prices: { exchange: string; price: number }[] = [];
  for (const exchange of config.exchanges) {
    const price = row.cells?.[exchange]?.markPrice;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      prices.push({ exchange, price });
    }
  }
  if (prices.length < 2) return null;
  let long = prices[0];
  let short = prices[0];
  for (const entry of prices) {
    if (entry.price < long.price) long = entry;
    if (entry.price > short.price) short = entry;
  }
  if (long.exchange === short.exchange) return null;
  return {
    symbol: row.symbol,
    spreadPct: (short.price - long.price) / long.price,
    longExchange: long.exchange,
    longPrice: long.price,
    shortExchange: short.exchange,
    shortPrice: short.price,
  };
}

/** Header message for the /arb command — venues, timestamp, disclaimer. */
export function formatOrbitArbitrageHeader(
  result: OrbitArbitrageResult,
  config: Pick<OrbitScreenerConfig, "exchanges" | "assetClass" | "topN">,
): string {
  const lines = [
    `🛰 ORBIT arbitrage — top ${config.topN} spreads (${config.assetClass})`,
    `Venues: ${config.exchanges.join(" · ")}`,
  ];
  if (result.updatedAt) {
    const [, timePart] = result.updatedAt.split("T");
    const stamp = timePart
      ? `${timePart.replace(/\.\d+Z?$/, "")} UTC`
      : result.updatedAt;
    lines.push(
      `Updated ${stamp} · ${result.evaluatedCount} assets priced on ≥2 venues` +
        (result.totalCount != null ? ` of ${result.totalCount}` : ""),
    );
  }
  if (result.rows.length === 0) {
    lines.push("", "No asset has mark prices on at least 2 of the venues.");
  }
  lines.push(
    "",
    "Mark price is mid-book — the executable spread is usually smaller.",
  );
  return lines.join("\n");
}

/**
 * One result row as its own Telegram message: the "Open Trade" button
 * must sit directly under its row, and an inline keyboard always hangs
 * from the whole message — so each row IS a message.
 */
export function formatArbitrageRowMessage(
  row: ArbitrageTopRow,
  index: number,
): string {
  const pct = (row.spreadPct * 100).toFixed(2);
  return (
    `${index + 1}. ${row.symbol} +${pct}%\n` +
    `   buy ${row.longExchange} @ ${formatPrice(row.longPrice)} / ` +
    `sell ${row.shortExchange} @ ${formatPrice(row.shortPrice)}`
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(1);
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(3);
  return price.toFixed(5);
}
