import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { BackendConfig } from "./config.js";
import type { BalanceService } from "./exchanges/balance-service.js";
import {
  createVolumeStatsService,
  type VolumeStatsService,
} from "./exchanges/volume-stats-service.js";
import { normalizeVolumeStats } from "./exchanges/volume-stats-normalizers.js";
import {
  createTradeAnalysisService,
  type TradeAnalysisService,
} from "./trades/trade-analysis-service.js";
import {
  normalizeTradeTimeline,
  normalizeUnhedgedActive,
  normalizeUnhedgedEvents,
} from "./trades/trade-analysis-normalizers.js";

export function createBackendApp(
  config: BackendConfig,
  balances: BalanceService,
  volumeStats: VolumeStatsService = createVolumeStatsService(),
  tradeAnalysis: TradeAnalysisService = createTradeAnalysisService(),
) {
  const app = express();
  app.disable("x-powered-by");

  app.use(createCorsMiddleware(config.corsAllowedOrigins));
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get(
    "/api/exchanges/balances",
    asyncHandler(async (_request, response) => {
      response.json(await balances.getAllBalances());
    }),
  );

  app.get(
    "/api/exchanges/risex/balance",
    asyncHandler(async (_request, response) => {
      response.json(await balances.getRisexBalance());
    }),
  );

  app.get(
    "/api/exchanges/extended/balance",
    asyncHandler(async (_request, response) => {
      response.json(await balances.getExtendedBalance());
    }),
  );

  // Read-only farmed-volume aggregation over the bot database (volume-stats-api spec).
  app.get(
    "/api/trades/volume-stats",
    asyncHandler(async (_request, response) => {
      response.json(normalizeVolumeStats(await volumeStats.getVolumeStats()));
    }),
  );

  // Read-only unhedged-window observability over the bot database
  // (unhedged-observability spec). No order placement, no exchange calls.
  app.get(
    "/api/trades/unhedged/active",
    asyncHandler(async (_request, response) => {
      const { generatedAt, trades } =
        await tradeAnalysis.getActiveUnhedgedTrades();
      response.json(normalizeUnhedgedActive(generatedAt, trades));
    }),
  );

  app.get(
    "/api/trades/unhedged/events",
    asyncHandler(async (request, response) => {
      const limit = parseBoundedQueryInt(request.query.limit, 1, 200, 50);
      const sinceDays = parseBoundedQueryInt(
        request.query.sinceDays,
        1,
        365,
        90,
      );
      const { generatedAt, events } = await tradeAnalysis.getUnhedgedEvents({
        limit,
        sinceDays,
      });
      response.json(normalizeUnhedgedEvents(generatedAt, events));
    }),
  );

  app.get(
    "/api/trades/:id/timeline",
    asyncHandler(async (request, response) => {
      const tradeId = Number(request.params.id);
      if (!Number.isInteger(tradeId)) {
        response.status(404).json({ error: "Trade not found" });
        return;
      }
      const timeline = await tradeAnalysis.getTradeTimeline(tradeId);
      if (!timeline) {
        response.status(404).json({ error: "Trade not found" });
        return;
      }
      response.json(normalizeTradeTimeline(timeline));
    }),
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const message =
        error instanceof Error ? error.message : "Unknown backend error";
      response.status(500).json({ error: message });
    },
  );

  return app;
}

function createCorsMiddleware(allowedOrigins: string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    const allowAnyOrigin = allowedOrigins.includes("*");
    const originIsAllowed = Boolean(origin && allowedOrigins.includes(origin));

    if (allowAnyOrigin) {
      response.header("access-control-allow-origin", origin ?? "*");
    } else if (originIsAllowed && origin) {
      response.header("access-control-allow-origin", origin);
    }

    response.header("vary", "Origin");
    response.header("access-control-allow-methods", "GET,OPTIONS");
    response.header("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  };
}

function parseBoundedQueryInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}
