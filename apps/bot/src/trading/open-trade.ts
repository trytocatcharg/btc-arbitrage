import { randomUUID } from 'node:crypto';
import { formatDecimal, parseDecimal, type ExchangeId, type MarketType } from '@btc-arbitrage/domain';
import type { BestBidOffer, ExchangeAdapter, ExecutionAdapter } from '@btc-arbitrage/exchange-core';
import { JsonFileLogger } from '../logging/json-file-logger.js';

export type OpenTradeState = 'awaiting_confirmation' | 'executing_limit' | 'hedging' | 'protecting' | 'open' | 'unhedged' | 'cancelled' | 'failed';
export interface OpenTradePreview { token: string; signalId: number; expiresAt: Date; symbol: string; marketType: MarketType; longExchange: ExchangeId; shortExchange: ExchangeId; limitExchange: ExchangeId; marketExchange: ExchangeId; quantityBase: string; longPriceUsd: string; shortPriceUsd: string; makerFeeBps: string; takerFeeBps: string; }
export interface PreviewStore { createPreview(preview: OpenTradePreview): Promise<void>; consumePreview(token: string, now: Date): Promise<OpenTradePreview | null>; startExecution(preview: OpenTradePreview): Promise<void>; claimRollback(token: string): Promise<boolean>; transition(token: string, state: OpenTradeState, details?: Record<string, unknown>): Promise<void>; }
export interface OpenTradeOptions { notionalUsd: string; ttlMs: number; quoteMaxAgeMs: number; limitTimeoutMs: number; residualDeltaToleranceBase: string; fees: Record<ExchangeId, { makerBps: string; takerBps: string }>; notifyUrgent?: (text: string) => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>; }

const openTradeLogger = new JsonFileLogger('logs/open-trade.jsonl');
const PASSIVE_LIMIT_RETRY_COUNT = 3;

export class OpenTradeService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly registry: { get(id: string): ExchangeAdapter }, private readonly store: PreviewStore, private readonly options: OpenTradeOptions) { this.now = options.now ?? (() => new Date()); this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms))); }

  async createPreview(input: { signalId: number; symbol: string; marketType: MarketType; exchanges: [ExchangeId, ExchangeId] }): Promise<OpenTradePreview> {
    const [a, b] = input.exchanges.map(id => this.registry.get(id));
    const [aBbo, bBbo, aMeta, bMeta] = await Promise.all([this.execution(a).getBestBidOffer({ symbol: input.symbol, marketType: input.marketType, priceSource: 'last' }), this.execution(b).getBestBidOffer({ symbol: input.symbol, marketType: input.marketType, priceSource: 'last' }), this.execution(a).getMarketMetadata({ symbol: input.symbol, marketType: input.marketType, priceSource: 'last' }), this.execution(b).getMarketMetadata({ symbol: input.symbol, marketType: input.marketType, priceSource: 'last' })]);
    this.assertFresh(aBbo.receivedAt); this.assertFresh(bBbo.receivedAt);
    const aSell = parseDecimal(aBbo.bidUsd), bSell = parseDecimal(bBbo.bidUsd);
    const short = aSell >= bSell ? a.id : b.id; const long = short === a.id ? b.id : a.id;
    const longQuote = long === a.id ? aBbo.askUsd : bBbo.askUsd; const shortQuote = short === a.id ? aBbo.bidUsd : bBbo.bidUsd;
    const limitExchange = parseDecimal(this.options.fees[short].makerBps) >= parseDecimal(this.options.fees[long].makerBps) ? short : long;
    const marketExchange = limitExchange === short ? long : short;
    const commonStep = Math.max(parseDecimal(aMeta.quantityStepBase), parseDecimal(bMeta.quantityStepBase));
    const min = Math.max(parseDecimal(aMeta.minQuantityBase), parseDecimal(bMeta.minQuantityBase));
    const quantity = Math.floor((parseDecimal(this.options.notionalUsd) / Math.max(parseDecimal(longQuote), parseDecimal(shortQuote))) / commonStep) * commonStep;
    if (quantity < min) throw new Error('Configured notional is below one or both market minimum quantities');
    const preview: OpenTradePreview = { token: randomUUID(), signalId: input.signalId, expiresAt: new Date(this.now().getTime() + this.options.ttlMs), symbol: input.symbol, marketType: input.marketType, longExchange: long, shortExchange: short, limitExchange, marketExchange, quantityBase: formatDecimal(quantity, 10), longPriceUsd: longQuote, shortPriceUsd: shortQuote, makerFeeBps: this.options.fees[limitExchange].makerBps, takerFeeBps: this.options.fees[marketExchange].takerBps };
    console.log('OpenTrade preview created', { token: preview.token, signalId: preview.signalId, longExchange: preview.longExchange, shortExchange: preview.shortExchange, limitExchange: preview.limitExchange, marketExchange: preview.marketExchange, quantityBase: preview.quantityBase, longPriceUsd: preview.longPriceUsd, shortPriceUsd: preview.shortPriceUsd });
    await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_preview_created', token: preview.token, signalId: preview.signalId, symbol: preview.symbol, longExchange: preview.longExchange, shortExchange: preview.shortExchange, limitExchange: preview.limitExchange, marketExchange: preview.marketExchange, quantityBase: preview.quantityBase, longPriceUsd: preview.longPriceUsd, shortPriceUsd: preview.shortPriceUsd, expiresAt: preview.expiresAt.toISOString() });
    await this.store.createPreview(preview); return preview;
  }

  async confirm(token: string): Promise<void> {
    console.log('OpenTrade confirm started', { token });
    await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_confirm_started', token });
    const preview = await this.store.consumePreview(token, this.now());
    if (!preview) throw new Error('Preview was already consumed, cancelled or expired');
    await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_preview_consumed', token, signalId: preview.signalId, symbol: preview.symbol, longExchange: preview.longExchange, shortExchange: preview.shortExchange, limitExchange: preview.limitExchange, marketExchange: preview.marketExchange, quantityBase: preview.quantityBase });
    await this.store.startExecution(preview); await this.store.transition(token, 'executing_limit');
    const limit = this.execution(this.registry.get(preview.limitExchange)); const market = this.execution(this.registry.get(preview.marketExchange)); let limitOrder: string | undefined; let covered = 0; const protectionOrderIds: Array<{ adapter: ExecutionAdapter; id: string }> = [];
    try {
      await Promise.all([limit.validateExecutionPreflight({ symbol: preview.symbol, leverage: 1 }), market.validateExecutionPreflight({ symbol: preview.symbol, leverage: 1 }), limit.getAvailableMarginUsd(), market.getAvailableMarginUsd()]);
      await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_preflight_ok', token, symbol: preview.symbol, limitExchange: preview.limitExchange, marketExchange: preview.marketExchange });
      const limitSide = preview.limitExchange === preview.shortExchange ? 'sell' : 'buy';
      const { order: submittedLimit } = await this.submitPassiveLimitWithRetry({
        adapter: limit,
        token,
        symbol: preview.symbol,
        exchangeId: preview.limitExchange,
        side: limitSide,
        quantityBase: preview.quantityBase
      });
      limitOrder = submittedLimit.id;
      let marketFillPrice: string | undefined; const started = this.now().getTime(); let current = submittedLimit;
      while (true) {
        const filled = parseDecimal(current.filledQuantityBase);
        if (filled > covered) { await this.store.transition(token, 'hedging'); const diff = filled - covered; covered = filled; const marketSide = preview.marketExchange === preview.shortExchange ? 'sell' : 'buy'; const hedge = await market.submitExecutionOrder({ clientOrderId: `${token}-hedge-${filled - diff}`, symbol: preview.symbol, side: marketSide, type: 'market', quantityBase: formatDecimal(diff, 10) }); console.log('OpenTrade hedge submitted', { token, marketExchange: preview.marketExchange, side: marketSide, quantityBase: formatDecimal(diff, 10), orderId: hedge.id, status: hedge.status, averageFillPriceUsd: hedge.averageFillPriceUsd }); await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_hedge_submitted', token, exchange: preview.marketExchange, side: marketSide, quantityBase: formatDecimal(diff, 10), orderId: hedge.id, status: hedge.status, averageFillPriceUsd: hedge.averageFillPriceUsd, coveredQuantityBase: formatDecimal(covered, 10) }); if (hedge.status !== 'filled' || !hedge.averageFillPriceUsd) throw new Error('Market hedge was not immediately filled'); marketFillPrice = hedge.averageFillPriceUsd; }
        if (current.status === 'filled' || this.now().getTime() - started >= this.options.limitTimeoutMs) break;
        await this.sleep(250); current = await limit.getExecutionOrder(submittedLimit.id);
      }
      if (current.status !== 'filled') { await limit.cancelExecutionOrder(submittedLimit.id); await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_limit_cancelled', token, orderId: submittedLimit.id, finalStatus: current.status, filledQuantityBase: current.filledQuantityBase }); }
      if (covered <= 0) { await this.store.transition(token, 'cancelled'); await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_cancelled_without_fill', token, orderId: submittedLimit.id, finalStatus: current.status }); return; }
      await this.store.transition(token, 'protecting');
      const limitFillPrice = current.averageFillPriceUsd; if (!limitFillPrice || !marketFillPrice) throw new Error('Cannot protect trade without confirmed fill prices');
      const longEntry = preview.limitExchange === preview.longExchange ? limitFillPrice : marketFillPrice; const longTp = formatDecimal(parseDecimal(longEntry) * 1.03); const longSl = formatDecimal(parseDecimal(longEntry) * .97);
      await this.protect(this.execution(this.registry.get(preview.longExchange)), token, preview.symbol, 'sell', covered, longTp, longSl, protectionOrderIds); await this.protect(this.execution(this.registry.get(preview.shortExchange)), token, preview.symbol, 'buy', covered, longSl, longTp, protectionOrderIds);
      await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_protection_submitted', token, coveredQuantityBase: formatDecimal(covered, 10), longTp, longSl, protectionOrderIds: protectionOrderIds.map((item) => item.id) });
      await this.store.transition(token, 'open', { quantityBase: formatDecimal(covered, 10), longTp, longSl });
      console.log('OpenTrade confirm completed', { token, coveredQuantityBase: formatDecimal(covered, 10), longTp, longSl });
      await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_confirm_completed', token, coveredQuantityBase: formatDecimal(covered, 10), longTp, longSl });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); console.error('OpenTrade confirm failed', { token, coveredQuantityBase: formatDecimal(covered, 10), limitOrder, message }); await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_confirm_failed', token, coveredQuantityBase: formatDecimal(covered, 10), limitOrder, protectionOrderIds: protectionOrderIds.map((item) => item.id), error: message }); if (covered > 0 && await this.store.claimRollback(token)) { const outcomes: string[] = []; if (limitOrder) { try { await limit.cancelExecutionOrder(limitOrder); outcomes.push('limit cancelled'); } catch { outcomes.push('limit cancel failed'); } } for (const item of protectionOrderIds) { try { await item.adapter.cancelExecutionOrder(item.id); outcomes.push(`protection ${item.id} cancelled`); } catch { outcomes.push(`protection ${item.id} cancel failed`); } } for (const [exchange, side] of [[preview.longExchange, 'sell'], [preview.shortExchange, 'buy']] as const) { try { await this.execution(this.registry.get(exchange)).submitExecutionOrder({ clientOrderId: `${token}-emergency-${exchange}`, symbol: preview.symbol, side, type: 'market', quantityBase: formatDecimal(covered, 10), reduceOnly: true }); outcomes.push(`${exchange} emergency close submitted`); } catch { outcomes.push(`${exchange} emergency close failed`); } } await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_rollback_attempted', token, outcomes }); await this.options.notifyUrgent?.(`🚨 Trade rollback ${token}: ${outcomes.join('; ')}`); } await this.store.transition(token, 'failed', { error: message }); throw error; }
  }
  private async submitPassiveLimitWithRetry(input: { adapter: ExecutionAdapter; token: string; symbol: string; exchangeId: ExchangeId; side: 'buy' | 'sell'; quantityBase: string }): Promise<{ order: Awaited<ReturnType<ExecutionAdapter['submitExecutionOrder']>>; priceUsd: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PASSIVE_LIMIT_RETRY_COUNT; attempt += 1) {
      const bbo = await input.adapter.getBestBidOffer({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
      const priceUsd = this.passiveLimitPriceFromBbo(bbo, input.side);
      try {
        const order = await input.adapter.submitExecutionOrder({ clientOrderId: `${input.token}-limit`, symbol: input.symbol, side: input.side, type: 'limit', quantityBase: input.quantityBase, priceUsd });
        console.log('OpenTrade limit submitted', { token: input.token, limitExchange: input.exchangeId, side: input.side, quantityBase: input.quantityBase, priceUsd, orderId: order.id, attempt });
        await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_limit_submitted', token: input.token, exchange: input.exchangeId, side: input.side, quantityBase: input.quantityBase, priceUsd, orderId: order.id, attempt });
        return { order, priceUsd };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn('OpenTrade limit submit failed', { token: input.token, exchange: input.exchangeId, side: input.side, priceUsd, attempt, message });
        await openTradeLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_limit_submit_failed', token: input.token, exchange: input.exchangeId, side: input.side, quantityBase: input.quantityBase, priceUsd, attempt, error: message });
        if (!message.includes('PostOnlyOrderMatched()') || attempt === PASSIVE_LIMIT_RETRY_COUNT) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Passive limit submission failed');
  }
  private passiveLimitPriceFromBbo(bbo: BestBidOffer, side: 'buy' | 'sell'): string {
    return side === 'buy' ? bbo.bidUsd : bbo.askUsd;
  }
  private async protect(adapter: ExecutionAdapter, token: string, symbol: string, closeSide: 'buy' | 'sell', qty: number, tp: string, sl: string, known: Array<{ adapter: ExecutionAdapter; id: string }>) { const a = await adapter.submitExecutionOrder({ clientOrderId: `${token}-tp`, symbol, side: closeSide, type: 'take-profit-market', quantityBase: formatDecimal(qty, 10), triggerPriceUsd: tp, reduceOnly: true }); known.push({ adapter, id: a.id }); const b = await adapter.submitExecutionOrder({ clientOrderId: `${token}-sl`, symbol, side: closeSide, type: 'stop-market', quantityBase: formatDecimal(qty, 10), triggerPriceUsd: sl, reduceOnly: true }); known.push({ adapter, id: b.id }); }
  private execution(adapter: ExchangeAdapter): ExecutionAdapter { if (!adapter.execution) throw new Error(`${adapter.id} does not expose execution primitives`); return adapter.execution; }
  private assertFresh(at: Date) { if (this.now().getTime() - at.getTime() > this.options.quoteMaxAgeMs) throw new Error('Executable BBO quote is stale'); }
}
