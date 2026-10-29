import { ExecutionMode, type PriceSnapshot } from "@btc-arbitrage/domain";
import type {
  ExchangeAdapter,
  ExchangeMarket,
  MarketStats,
  PriceRequest,
} from "@btc-arbitrage/exchange-core";
import { normalizeSymbol } from "@btc-arbitrage/exchange-core";
import { QfexHttpClient } from "./qfex-http-client.js";
import type { QfexConfig } from "./qfex.types.js";
import { createQfexExecutionAdapter } from "./qfex-execution-adapter.js";
import { resolveQfexContract } from "./qfex-symbol.js";

export function createQfexAdapter(
  config: QfexConfig,
  http = new QfexHttpClient(config),
): ExchangeAdapter {
  return {
    id: "qfex",
    displayName: "QFEX",
    capabilities: {
      nativeFetch: true,
      // Order entry runs over the trade WebSocket, but MARKET DATA is
      // polled over REST — the bot polls at 1 Hz and consumes no WS
      // market-data stream, same posture as the other adapters.
      websocket: "polling-only",
      orderPlacement: config.tradingEnabled,
    },
    execution: createQfexExecutionAdapter(config, http),
    async getMarkets(): Promise<ExchangeMarket[]> {
      const payload = await http.get("/md/contracts");
      const contract = resolveQfexContract(payload, "BTCUSDT");
      return [
        {
          exchangeId: "qfex",
          normalizedSymbol: normalizeSymbol(contract.ticker_id),
          externalMarketId: contract.ticker_id,
          marketType: "perpetual",
          // QFEX REST exposes index_price / last_price only — there is NO
          // mark price in the REST surface (docs/exchanges/qfex.md).
          supportsPriceSources: ["index", "last"],
          raw: contract,
        },
      ];
    },
    async getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot> {
      if (input.priceSource === "mark") {
        throw new Error(
          "QFEX has no mark price in its REST surface (/md/contracts exposes " +
            "index_price and last_price only); set PRICE_SOURCE=index or last " +
            "when QFEX is in the monitored pair",
        );
      }
      const payload = await http.get("/md/contracts");
      const contract = resolveQfexContract(payload, input.symbol);
      const priceUsd =
        input.priceSource === "index"
          ? contract.index_price
          : contract.last_price;
      if (!priceUsd || Number(priceUsd) <= 0) {
        // Fail closed: never fall back to the other source silently.
        throw new Error(
          `QFEX contract ${contract.ticker_id} has no usable ${input.priceSource} price`,
        );
      }
      return {
        exchangeId: "qfex",
        symbol: input.symbol,
        externalMarketId: contract.ticker_id,
        marketType: input.marketType,
        priceSource: input.priceSource,
        priceUsd,
        exchangeTimestamp: new Date(),
        receivedAt: new Date(),
        raw: contract,
      };
    },
    async getMarketStats(input: PriceRequest): Promise<MarketStats> {
      const payload = await http.get("/md/contracts");
      // Contracts carry base_volume/target_volume with NO explicit 24h
      // window in the schema — the pair is CoinGecko-style ticker volume,
      // but that is an assumption, not a documented fact, so 24h USD volume
      // stays unknown ("n/d") until verified live (docs/exchanges/qfex.md).
      resolveQfexContract(payload, input.symbol);
      return {};
    },
    async createOrder() {
      return {
        mode: ExecutionMode.DryRun,
        symbol: "BTCUSDT",
        leverage: 0,
        status: "blocked",
        guardrailReason:
          "QFEX live order placement is gated; requires QFEX_TRADING_ENABLED=true plus QFEX_API_KEY/QFEX_SECRET_KEY and goes through the trade WebSocket.",
        createdAt: new Date(),
      };
    },
  };
}
