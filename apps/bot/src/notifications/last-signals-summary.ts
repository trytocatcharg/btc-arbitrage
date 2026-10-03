import type { getDb } from "@btc-arbitrage/db";
import { signals } from "@btc-arbitrage/db";
import { desc } from "drizzle-orm";

const LAST_SIGNALS_LIMIT = 10;

type SignalRow = typeof signals.$inferSelect;

/** Renders the /lastsignal Telegram message: the most recent signals with
 * the timestamp in the operator's local timezone plus a relative age
 * ("hace 2 minutos"). Telegram never sends the sender's device timezone,
 * so the timezone comes from TELEGRAM_OPERATOR_TIMEZONE. */
export async function buildLastSignalsMessage(
  db: Awaited<ReturnType<typeof getDb>>,
  timeZone: string,
  now: Date = new Date(),
): Promise<string> {
  const rows = await db
    .select()
    .from(signals)
    .orderBy(desc(signals.createdAt))
    .limit(LAST_SIGNALS_LIMIT);

  if (rows.length === 0) {
    return "📡 Últimas señales\n\nNo hay señales registradas.";
  }

  return [
    `📡 Últimas ${rows.length} señales (${timeZone})`,
    "",
    ...rows.flatMap((row) => formatSignalLines(row, timeZone, now)),
  ].join("\n");
}

function formatSignalLines(
  row: SignalRow,
  timeZone: string,
  now: Date,
): string[] {
  const createdAt = new Date(row.createdAt);
  const spread = Number(row.observedDiffUsd);
  return [
    `#${row.id} · long ${row.longExchange} / short ${row.shortExchange}`,
    `   $${Number.isFinite(spread) ? spread.toFixed(2) : row.observedDiffUsd} · ${formatLocalTimestamp(createdAt, timeZone, now)} (${formatRelativeAge(createdAt, now)})`,
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
    return `ayer ${formatParts(date, timeZone, ["hour", "minute", "second"])}`;
  }
  return formatParts(date, timeZone, ["day", "month", "hour", "minute"]);
}

function formatRelativeAge(from: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 1000),
  );
  if (seconds < 10) return "justo ahora";
  if (seconds < 60) return `hace ${seconds} segundos`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} minuto${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} hora${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
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
