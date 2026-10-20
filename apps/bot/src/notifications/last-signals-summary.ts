import type { getDb } from "@btc-arbitrage/db";
import { signals, spreadSnapshots } from "@btc-arbitrage/db";
import { desc, eq } from "drizzle-orm";

const LAST_SIGNALS_LIMIT = 10;

type SpreadRow = typeof spreadSnapshots.$inferSelect;

/** Renders the /lastsignal Telegram message: the most recent spread ticks,
 * regardless of whether they crossed the threshold, with the timestamp in
 * the operator's local timezone plus a relative age ("hace 2 minutos").
 * Ticks that generated a signal link to it. Telegram never sends the
 * sender's device timezone, so the timezone comes from
 * TELEGRAM_OPERATOR_TIMEZONE. */
export async function buildLastSignalsMessage(
  db: Awaited<ReturnType<typeof getDb>>,
  timeZone: string,
  now: Date = new Date(),
): Promise<string> {
  const rows = await db
    .select({ spread: spreadSnapshots, signalId: signals.id })
    .from(spreadSnapshots)
    .leftJoin(signals, eq(signals.spreadId, spreadSnapshots.id))
    .orderBy(desc(spreadSnapshots.calculatedAt))
    .limit(LAST_SIGNALS_LIMIT);

  if (rows.length === 0) {
    return "📡 Last signals\n\nNo ticks recorded yet.";
  }

  return [
    `📡 Last ${rows.length} ticks (${timeZone})`,
    "",
    ...rows.flatMap((row) =>
      formatTickLines(row.spread, row.signalId, timeZone, now),
    ),
  ].join("\n");
}

function formatTickLines(
  row: SpreadRow,
  signalId: number | null,
  timeZone: string,
  now: Date,
): string[] {
  const calculatedAt = new Date(row.calculatedAt);
  const spread = Number(row.absoluteDiffUsd);
  const longExchange =
    row.direction === "a_above_b" ? row.exchangeB : row.exchangeA;
  const shortExchange =
    row.direction === "a_above_b" ? row.exchangeA : row.exchangeB;
  const direction =
    row.direction === "flat"
      ? "flat"
      : `long ${longExchange} / short ${shortExchange}`;
  const marker = row.thresholdMatched ? "✅ threshold" : "below threshold";
  const signalRef = signalId != null ? ` → signal #${signalId}` : "";
  return [
    `#${row.id} · ${direction}${signalRef}`,
    `   $${Number.isFinite(spread) ? spread.toFixed(2) : row.absoluteDiffUsd} · ${marker} · ${formatLocalTimestamp(calculatedAt, timeZone, now)} (${formatRelativeAge(calculatedAt, now)})`,
  ];
}

/** Local wall-clock label for the operator: HH:MM:SS today, "ayer HH:MM:SS"
 * for yesterday, DD/MM HH:MM for anything older. All in the given IANA
 * timezone, so it matches what the operator sees on their phone. */
function formatLocalTimestamp(date: Date, timeZone: string, now: Date): string {
  const today = dayKey(now, timeZone);
  const day = dayKey(date, timeZone);
  if (day === today) return formatParts(date, timeZone, ["hour", "minute", "second"]);

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (day === dayKey(yesterday, timeZone)) {
    return `yesterday ${formatParts(date, timeZone, ["hour", "minute", "second"])}`;
  }
  return formatParts(date, timeZone, ["day", "month", "hour", "minute"]);
}

function formatRelativeAge(from: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 1000),
  );
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** YYYY-MM-DD of the instant in the given timezone (en-CA renders ISO
 * order); used to compare calendar days, not elapsed 24 h windows. */
function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatParts(
  date: Date,
  timeZone: string,
  wanted: Array<"day" | "month" | "hour" | "minute" | "second">,
): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const rendered = wanted.map((type) => byType.get(type) ?? "00");
  // "day, month" → "DD/MM"; time fields → ":"-joined.
  if (wanted[0] === "day") {
    return `${rendered[0]}/${rendered[1]} ${rendered.slice(2).join(":")}`;
  }
  return rendered.join(":");
}
