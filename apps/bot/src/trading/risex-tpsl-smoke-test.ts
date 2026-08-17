import { formatDecimal, parseDecimal, type MarketType } from '@btc-arbitrage/domain';
import type { BotConfig } from '@btc-arbitrage/config';
import type { ExchangeAdapter, ExecutionAdapter } from '@btc-arbitrage/exchange-core';
import { ExchangeClient } from '../exchanges/risex/sdk/ExchangeClient.js';
import { RisexHttpClient } from '../exchanges/risex/risex-http-client.js';

const ENTRY_WAIT_TIMEOUT_MS = 30_000;
const ENTRY_WAIT_INTERVAL_MS = 1_000;

export interface RisexTpSlSmokeTestResult {
  symbol: string;
  marketType: MarketType;
  quantityBase: string;
  bestBidUsd: string;
  bestAskUsd: string;
  priceStepUsd: string;
  entryLimitPriceUsd: string;
  takeProfitTriggerPriceUsd: string;
  stopLossTriggerPriceUsd: string;
  entryOrderId: string;
  entryFilled: boolean;
  takeProfitOrderId?: string;
  stopLossOrderId?: string;
  operatorBudgetApproved: boolean;
}

export class RisexTpSlSmokeTestService {
  constructor(private readonly config: BotConfig, private readonly registry: { get(id: string): ExchangeAdapter }, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  async run(): Promise<RisexTpSlSmokeTestResult> {
    const adapter = this.registry.get('risex');
    const execution = this.requireExecution(adapter);
    const http = new RisexHttpClient(this.config.risex.apiBaseUrl);
    const client = new ExchangeClient({
      baseUrl: this.config.risex.apiBaseUrl,
      account: this.config.risex.accountAddress,
      accountKey: this.config.risex.accountPrivateKey,
      signerKey: this.config.risex.sessionSignerPrivateKey!
    }, http);
    await client.init();

    const [bbo, metadata, markets, longPosition, shortPosition] = await Promise.all([
      execution.getBestBidOffer({ symbol: this.config.btcSymbol, marketType: this.config.marketType, priceSource: 'last' }),
      execution.getMarketMetadata({ symbol: this.config.btcSymbol, marketType: this.config.marketType, priceSource: 'last' }),
      adapter.getMarkets(),
      execution.getPosition({ symbol: this.config.btcSymbol, side: 'long' }),
      execution.getPosition({ symbol: this.config.btcSymbol, side: 'short' })
    ]);

    if (longPosition?.status === 'open' && parseDecimal(longPosition.quantityBase) > 0) throw new Error('RISEx TP/SL smoke test requires no existing long position on the configured symbol');
    if (shortPosition?.status === 'open' && parseDecimal(shortPosition.quantityBase) > 0) throw new Error('RISEx TP/SL smoke test requires no existing short position on the configured symbol');

    const market = markets.find((candidate) => candidate.normalizedSymbol === normalizeSymbol(this.config.btcSymbol)) ?? markets[0];
    if (!market || !isRecord(market.raw)) throw new Error('RISEx market raw payload is required to derive step price for the TPSL smoke test');
    const marketConfig = requiredRecord(market.raw.config, 'RISEx market config');
    const priceStepUsd = decimalField(marketConfig.step_price ?? marketConfig.price_step ?? marketConfig.stepPrice, 'RISEx market price step');
    const quantityBase = metadata.minQuantityBase;
    const entryLimitPriceUsd = subtractOneTick(bbo.askUsd, priceStepUsd);
    const takeProfitTriggerPriceUsd = formatDecimal(parseDecimal(entryLimitPriceUsd) * 1.1, 10);
    const stopLossTriggerPriceUsd = formatDecimal(parseDecimal(entryLimitPriceUsd) * 0.9, 10);

    await execution.validateExecutionPreflight({ symbol: this.config.btcSymbol, leverage: 1 });
    await client.approvePermitSingleBudget();

    const entry = await execution.submitExecutionOrder({
      clientOrderId: `risex-tpsl-${Date.now()}`,
      symbol: this.config.btcSymbol,
      side: 'buy',
      type: 'limit',
      quantityBase,
      priceUsd: entryLimitPriceUsd
    });

    const entryFilled = await this.waitForLongFill(execution, quantityBase);
    if (!entryFilled) {
      return {
        symbol: this.config.btcSymbol,
        marketType: this.config.marketType,
        quantityBase,
        bestBidUsd: bbo.bidUsd,
        bestAskUsd: bbo.askUsd,
        priceStepUsd,
        entryLimitPriceUsd,
        takeProfitTriggerPriceUsd,
        stopLossTriggerPriceUsd,
        entryOrderId: entry.id,
        entryFilled: false,
        operatorBudgetApproved: true
      };
    }

    const takeProfit = await execution.submitExecutionOrder({
      clientOrderId: `risex-tpsl-${Date.now()}-tp`,
      symbol: this.config.btcSymbol,
      side: 'sell',
      type: 'take-profit-market',
      quantityBase,
      triggerPriceUsd: takeProfitTriggerPriceUsd,
      reduceOnly: true
    });
    const stopLoss = await execution.submitExecutionOrder({
      clientOrderId: `risex-tpsl-${Date.now()}-sl`,
      symbol: this.config.btcSymbol,
      side: 'sell',
      type: 'stop-market',
      quantityBase,
      triggerPriceUsd: stopLossTriggerPriceUsd,
      reduceOnly: true
    });

    return {
      symbol: this.config.btcSymbol,
      marketType: this.config.marketType,
      quantityBase,
      bestBidUsd: bbo.bidUsd,
      bestAskUsd: bbo.askUsd,
      priceStepUsd,
      entryLimitPriceUsd,
      takeProfitTriggerPriceUsd,
      stopLossTriggerPriceUsd,
      entryOrderId: entry.id,
      entryFilled: true,
      takeProfitOrderId: takeProfit.id,
      stopLossOrderId: stopLoss.id,
      operatorBudgetApproved: true
    };
  }

  private async waitForLongFill(execution: ExecutionAdapter, minimumQuantityBase: string): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= ENTRY_WAIT_TIMEOUT_MS) {
      const position = await execution.getPosition({ symbol: this.config.btcSymbol, side: 'long' });
      if (position?.status === 'open' && parseDecimal(position.quantityBase) >= parseDecimal(minimumQuantityBase)) return true;
      await this.sleep(ENTRY_WAIT_INTERVAL_MS);
    }
    return false;
  }

  private requireExecution(adapter: ExchangeAdapter): ExecutionAdapter {
    if (!adapter.execution) throw new Error('RISEx execution adapter is not available');
    return adapter.execution;
  }
}

function subtractOneTick(value: string, tick: string): string {
  const next = parseDecimal(value) - parseDecimal(tick);
  if (next <= 0) throw new Error('Cannot place a limit order one tick below the current ask because the computed price is not positive');
  return formatDecimal(next, 10);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}

function decimalField(value: unknown, label: string): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error(`${label} must be a decimal string`);
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
