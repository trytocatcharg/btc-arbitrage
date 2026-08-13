import express, { type NextFunction, type Request, type Response } from 'express';
import type { BackendConfig } from './config.js';
import type { BalanceService } from './exchanges/balance-service.js';

export function createBackendApp(config: BackendConfig, balances: BalanceService) {
  const app = express();
  app.disable('x-powered-by');

  app.use(createCorsMiddleware(config.corsAllowedOrigins));
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/exchanges/balances', asyncHandler(async (_request, response) => {
    response.json(await balances.getAllBalances());
  }));

  app.get('/api/exchanges/risex/balance', asyncHandler(async (_request, response) => {
    response.json(await balances.getRisexBalance());
  }));

  app.get('/api/exchanges/extended/balance', asyncHandler(async (_request, response) => {
    response.json(await balances.getExtendedBalance());
  }));

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unknown backend error';
    response.status(500).json({ error: message });
  });

  return app;
}

function createCorsMiddleware(allowedOrigins: string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header('origin');
    const allowAnyOrigin = allowedOrigins.includes('*');
    const originIsAllowed = Boolean(origin && allowedOrigins.includes(origin));

    if (allowAnyOrigin) {
      response.header('access-control-allow-origin', origin ?? '*');
    } else if (originIsAllowed && origin) {
      response.header('access-control-allow-origin', origin);
    }

    response.header('vary', 'Origin');
    response.header('access-control-allow-methods', 'GET,OPTIONS');
    response.header('access-control-allow-headers', 'content-type');

    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }

    next();
  };
}

function asyncHandler(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}
