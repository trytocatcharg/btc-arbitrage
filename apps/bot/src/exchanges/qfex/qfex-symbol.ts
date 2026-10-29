import { normalizeSymbol } from "@btc-arbitrage/exchange-core";
import type { QfexContract, QfexRefdataSymbol } from "./qfex.types.js";

/** QFEX perp symbols are dash-joined `<BASE>-USD` (e.g. BTC-USD, AAPL-USD).
 * The bot's canonical symbol is quote-suffixed (BTCUSDT / AAPLUSD), so the
 * mapping strips the quote to the base asset and re-joins with "-USD". The
 * resolved form is only trusted when a payload row VERIFIES it: the row's
 * symbol field must equal the dash form AND its base-asset field must equal
 * the base — anything else fails closed (docs/exchanges/qfex.md). */
export function qfexSymbolFor(botSymbol: string): { base: string; qfexSymbol: string } {
  const normalized = normalizeSymbol(botSymbol);
  const base = extractBaseAsset(normalized);
  if (!base) throw new Error(`Cannot derive a QFEX base asset from ${botSymbol}`);
  return { base, qfexSymbol: `${base}-USD` };
}

/** Resolve a /md/contracts payload row for a bot symbol, fail-closed. */
export function resolveQfexContract(
  payload: unknown,
  botSymbol: string,
): QfexContract {
  const { base, qfexSymbol } = qfexSymbolFor(botSymbol);
  for (const row of asRecords(payload, "data")) {
    if (
      typeof row.ticker_id === "string" &&
      row.ticker_id.toUpperCase() === qfexSymbol &&
      typeof row.base_currency === "string" &&
      row.base_currency.toUpperCase() === base &&
      row.target_currency === "USD"
    ) {
      // SAFETY: the fields read downstream (prices, volumes) are validated
      // per-access by the callers; here the row is verified by identity.
      return row as unknown as QfexContract;
    }
  }
  throw new Error(
    `QFEX contract ${qfexSymbol} was not found in /md/contracts (base ${base}); refusing to guess`,
  );
}

/** Resolve a /refdata payload row for a bot symbol, fail-closed. */
export function resolveQfexRefdata(
  payload: unknown,
  botSymbol: string,
): QfexRefdataSymbol {
  const { base, qfexSymbol } = qfexSymbolFor(botSymbol);
  for (const row of asRecords(payload, "data")) {
    if (
      typeof row.symbol === "string" &&
      row.symbol.toUpperCase() === qfexSymbol &&
      typeof row.base_asset === "string" &&
      row.base_asset.toUpperCase() === base &&
      row.quote_asset === "USD"
    ) {
      // SAFETY: numeric/string fields are validated per-access by callers;
      // here the row is verified by identity.
      return row as unknown as QfexRefdataSymbol;
    }
  }
  throw new Error(
    `QFEX refdata for ${qfexSymbol} was not found in /refdata (base ${base}); refusing to guess`,
  );
}

function asRecords(payload: unknown, key: string): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("QFEX response payload was not an object");
  }
  const data = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(data)) {
    throw new Error(`QFEX response payload is missing the ${key} array`);
  }
  return data.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

function extractBaseAsset(normalizedSymbol: string): string {
  for (const quote of ["USDT", "USDC", "USD"]) {
    if (
      normalizedSymbol.endsWith(quote) &&
      normalizedSymbol.length > quote.length
    ) {
      return normalizedSymbol.slice(0, -quote.length);
    }
  }
  return normalizedSymbol;
}
