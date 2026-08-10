import type { ExecutionMode } from '@btc-arbitrage/domain';

export type { ExecutionMode };
export type OperationStatus = 'planned' | 'open' | 'closing' | 'closed' | 'failed';
export type OperationSide = 'long' | 'short';

export interface OperationLeg {
  exchangeId: string;
  side: OperationSide;
  entryPriceUsd: number;
  markPriceUsd: number;
  quantityBtc: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  unrealizedPnlUsd: number;
  feesUsd: number;
  fundingUsd: number;
  liquidationPriceUsd?: number;
}

export interface ArbitrageOperation {
  id: string;
  mode: ExecutionMode;
  status: OperationStatus;
  symbol: string;
  openedAt: string;
  updatedAt: string;
  spreadAtEntryUsd: number;
  thresholdUsd: number;
  legs: [OperationLeg, OperationLeg];
}

export interface OperationPnlSummary {
  grossPnlUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netPnlUsd: number;
}

export function calculateOperationPnl(operation: ArbitrageOperation): OperationPnlSummary {
  const grossPnlUsd = operation.legs.reduce((total, leg) => total + leg.unrealizedPnlUsd, 0);
  const feesUsd = operation.legs.reduce((total, leg) => total + leg.feesUsd, 0);
  const fundingUsd = operation.legs.reduce((total, leg) => total + leg.fundingUsd, 0);

  return {
    grossPnlUsd,
    feesUsd,
    fundingUsd,
    netPnlUsd: grossPnlUsd - feesUsd + fundingUsd
  };
}

export function isProfitable(summary: OperationPnlSummary): boolean {
  return summary.netPnlUsd > 0;
}
