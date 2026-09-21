import fs from "node:fs";
import mysql from "mysql2/promise";

const log = (m: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
log("start");
const envFile = fs.readFileSync(".env", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m || line.trim().startsWith("#")) continue;
  const val = m[2].replace(/^["']|["']$/g, "");
  if (process.env[m[1]] === undefined) process.env[m[1]] = val;
}
const SCRATCH = "scratch_vol_stats_pr3";
process.env.DATABASE_DB_NAME = SCRATCH;
log(".env parsed, connecting root (no db)");

const root = await mysql.createConnection({
  host: process.env.DATABASE_HOST_NAME ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DATABASE_USER_NAME,
  password: process.env.DATABASE_USER_PASSWORD,
  multipleStatements: true,
});
log("root connected");
await root.query("DROP DATABASE IF EXISTS scratch_vol_stats_pr3");
await root.query("CREATE DATABASE scratch_vol_stats_pr3");
await root.end();
log("scratch DB created");

const conn = await mysql.createConnection({
  host: process.env.DATABASE_HOST_NAME ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DATABASE_USER_NAME,
  password: process.env.DATABASE_USER_PASSWORD,
  database: SCRATCH,
  multipleStatements: true,
});
log("scratch connected");

const apply = async (file: string) => {
  const raw = fs.readFileSync(file, "utf8");
  const statements = file.includes("_create_schema")
    ? [raw]
    : raw
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
  for (const s of statements) await conn.query(s);
};
await apply("packages/db/scripts/001_create_schema.sql");
await apply("packages/db/migrations/0002_fix_timestamp_defaults.sql");
await apply("packages/db/migrations/0003_filled_notional_volume.sql");
log("schema + migrations applied");

const { createVolumeStatsService } = await import(
  "./apps/backend/src/exchanges/volume-stats-service.ts"
);
log("service imported");

const fmt = (v: string) => Number(v).toFixed(2);
const assertEq = (label: string, actual: string, expected: number) => {
  const ok = Math.abs(Number(actual) - expected) < 0.005;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}: got ${fmt(actual)} expected ${expected.toFixed(2)}`,
  );
  if (!ok) process.exitCode = 1;
};

let stats = await createVolumeStatsService().getVolumeStats();
assertEq("empty lifetime total", stats.lifetime.totalUsd, 0);
console.log(`PASS empty byVenue empty: ${stats.lifetime.byVenue.length === 0}`);
if (stats.lifetime.byVenue.length !== 0) process.exitCode = 1;
log("empty-state verified");

const now = Date.now();
const H = 3600_000,
  D = 24 * H;
async function seedTrade(
  filled: number,
  updatedAgoMs: number,
  legs: Array<[string, number]>,
) {
  const [t] = await conn.query(
    `INSERT INTO trades (symbol, market_type, price_source, mode, status, long_exchange, short_exchange, leverage, filled_notional_usd, created_at, updated_at)
     VALUES ('BTCUSDT','perpetual','mark','live','closed','extended','risex',3,?,FROM_UNIXTIME(?/1000),FROM_UNIXTIME(?/1000))`,
    [filled, now - updatedAgoMs, now - updatedAgoMs],
  );
  const tradeId = (t as { insertId: number }).insertId;
  for (const [exchangeId, notional] of legs) {
    await conn.query(
      `INSERT INTO trade_legs (trade_id, exchange_id, side, status, filled_notional_usd, opened_at, closed_at)
       VALUES (?,?,?,'closed',?,FROM_UNIXTIME(?/1000),FROM_UNIXTIME(?/1000))`,
      [
        tradeId,
        exchangeId,
        exchangeId === "risex" ? "sell" : "buy",
        notional,
        now - updatedAgoMs,
        now - updatedAgoMs,
      ],
    );
  }
}
await seedTrade(300, 1 * H, [
  ["risex", 150],
  ["extended", 150],
]);
await seedTrade(100, 2 * H, [["extended", 100]]);
await seedTrade(700, 10 * D, [
  ["risex", 400],
  ["extended", 300],
]);
log("seeded 3 trades");

stats = await createVolumeStatsService().getVolumeStats();
assertEq("lifetime total", stats.lifetime.totalUsd, 1100);
const venue = (id: string) =>
  Number(
    stats.lifetime.byVenue.find((v) => v.exchangeId === id)?.volumeUsd ?? 0,
  );
assertEq("lifetime risex", String(venue("risex")), 550);
assertEq("lifetime extended", String(venue("extended")), 550);
assertEq("24h total", stats.windows["24h"].totalUsd, 400);
assertEq("7d total", stats.windows["7d"].totalUsd, 400);
assertEq("30d total", stats.windows["30d"].totalUsd, 1100);
const w24 = (id: string) =>
  Number(
    stats.windows["24h"].byVenue.find((v) => v.exchangeId === id)?.volumeUsd ??
      0,
  );
assertEq("24h risex", String(w24("risex")), 150);
assertEq("24h extended", String(w24("extended")), 250);
console.log(`PASS generatedAt is Date: ${stats.generatedAt instanceof Date}`);

await conn.end();
const cleanup = await mysql.createConnection({
  host: process.env.DATABASE_HOST_NAME ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DATABASE_USER_NAME,
  password: process.env.DATABASE_USER_PASSWORD,
  multipleStatements: true,
});
await cleanup.query("DROP DATABASE IF EXISTS scratch_vol_stats_pr3");
await cleanup.end();
log("scratch DB dropped — done");
process.exit(process.exitCode ?? 0);
