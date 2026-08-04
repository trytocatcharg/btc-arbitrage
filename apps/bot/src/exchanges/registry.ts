import type { BotConfig } from '@btc-arbitrage/config';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import { createArcusAdapter } from './arcus/arcus-client.js';
import { createExtendedAdapter } from './extended/extended-client.js';
import { createRisexAdapter } from './risex/risex-client.js';

export function createExchangeRegistry(config: BotConfig) {
  const adapters = new Map<string, ExchangeAdapter>([
    ['risex', createRisexAdapter(config.risex)],
    ['extended', createExtendedAdapter(config.extended)],
    ['arcus', createArcusAdapter(config.arcus)]
  ]);

  return {
    get(id: string): ExchangeAdapter {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`Unsupported exchange: ${id}`);
      return adapter;
    }
  };
}
