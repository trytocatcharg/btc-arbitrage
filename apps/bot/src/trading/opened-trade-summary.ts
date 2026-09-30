import { eq } from "drizzle-orm";
import { getDb, tradeLegs, tradePreviews } from "@btc-arbitrage/db";
import { parseDecimal } from "@btc-arbitrage/domain";

type BotDatabase = Awaited<ReturnType<typeof getDb>>;

/** Formats the "trade opened" fill summary. Shared by the Telegram confirm
 * flow (operator clicks) and the auto-confirm path (auto-trading): both
 * must surface identical open notifications. */
export async function buildTradeOpenedSummary(
  db: BotDatabase,
  token: string,
): Promise<string> {
  const previewRow = (
    await db
      .select({ tradeId: tradePreviews.tradeId })
      .from(tradePreviews)
      .where(eq(tradePreviews.token, token))
  )[0];
  if (!previewRow?.tradeId) return "✅ Trade execution completed.";
  const legs = await db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, previewRow.tradeId));
  const longLeg = legs.find((leg) => leg.side === "long");
  const shortLeg = legs.find((leg) => leg.side === "short");
  const lines = [`✅ Trade opened (${token.slice(0, 8)})`];
  if (longLeg)
    lines.push(
      `Long: ${longLeg.exchangeId} @ $${longLeg.entryPriceUsd ?? "?"} ${longLeg.status}`,
    );
  if (shortLeg)
    lines.push(
      `Short: ${shortLeg.exchangeId} @ $${shortLeg.entryPriceUsd ?? "?"} ${shortLeg.status}`,
    );
  if (legs[0]) lines.push(`Quantity: ${legs[0].quantityBase} BTC`);
  // Farmed volume surfaced from the persisted filled_notional_usd
  // columns (design D6 / volume-farming spec), not a live-price estimate.
  const farmedVolumeUsd = legs.reduce(
    (sum, leg) => sum + parseDecimal(leg.filledNotionalUsd ?? "0"),
    0,
  );
  lines.push(`Farmed volume: $${farmedVolumeUsd.toFixed(2)}`);
  lines.push("TP/SL placed on both legs (percentages on margin).");
  return lines.join("\n");
}

/** Both fills completed but the captured spread no longer covered exit
 * cost + minimum profit; the legs were closed at market immediately. */
export function formatEdgeClosedNotice(confirmOutcome: {
  realizedPnlUsd: string | null;
  capturedSpreadUsd: number;
  minEdgeUsd: number;
}): string {
  const pnlText =
    confirmOutcome.realizedPnlUsd == null
      ? "n/a"
      : `$${Number(confirmOutcome.realizedPnlUsd).toFixed(2)}`;
  return (
    `⚖️ Edge insuficiente al llenar: spread capturado ` +
    `$${confirmOutcome.capturedSpreadUsd.toFixed(2)} vs mínimo ` +
    `$${confirmOutcome.minEdgeUsd.toFixed(2)}. Ambas patas ` +
    `cerradas al momento. PnL realizado: ${pnlText}.`
  );
}
