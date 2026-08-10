import { ExecutionMode } from '@btc-arbitrage/domain';
import type { ArbitrageOperation } from './operations.js';

const randomUnrealizedPnlUsd = () => randomUsd(-14, 14);
const randomFundingUsd = () => randomUsd(-0.85, 0.85);

export const mockOpenOperations: ArbitrageOperation[] = [
  {
    id: 'dry-run-op-001',
    mode: ExecutionMode.DryRun,
    status: 'open',
    symbol: 'BTCUSDT',
    openedAt: '2026-08-10T10:18:00.000Z',
    updatedAt: '2026-08-10T10:24:00.000Z',
    spreadAtEntryUsd: 52.4,
    thresholdUsd: 40,
    legs: [
      {
        exchangeId: 'risex',
        side: 'long',
        entryPriceUsd: 118_420.2,
        markPriceUsd: 118_510.6,
        quantityBtc: 0.08,
        notionalUsd: 9_473.62,
        marginUsd: 3_157.87,
        leverage: 3,
        unrealizedPnlUsd: randomUnrealizedPnlUsd(),
        feesUsd: 4.74,
        fundingUsd: randomFundingUsd(),
        liquidationPriceUsd: 79_240.15
      },
      {
        exchangeId: 'extended',
        side: 'short',
        entryPriceUsd: 118_472.6,
        markPriceUsd: 118_443.8,
        quantityBtc: 0.08,
        notionalUsd: 9_477.81,
        marginUsd: 3_159.27,
        leverage: 3,
        unrealizedPnlUsd: randomUnrealizedPnlUsd(),
        feesUsd: 4.74,
        fundingUsd: randomFundingUsd(),
        liquidationPriceUsd: 157_960.11
      }
    ]
  },
  {
    id: 'dry-run-op-002',
    mode: ExecutionMode.DryRun,
    status: 'open',
    symbol: 'BTCUSDT',
    openedAt: '2026-08-10T09:42:00.000Z',
    updatedAt: '2026-08-10T10:24:00.000Z',
    spreadAtEntryUsd: 44.1,
    thresholdUsd: 40,
    legs: [
      {
        exchangeId: 'arcus',
        side: 'long',
        entryPriceUsd: 118_690.4,
        markPriceUsd: 118_612.9,
        quantityBtc: 0.05,
        notionalUsd: 5_934.52,
        marginUsd: 1_978.17,
        leverage: 3,
        unrealizedPnlUsd: randomUnrealizedPnlUsd(),
        feesUsd: 2.97,
        fundingUsd: randomFundingUsd(),
        liquidationPriceUsd: 79_164.38
      },
      {
        exchangeId: 'extended',
        side: 'short',
        entryPriceUsd: 118_734.5,
        markPriceUsd: 118_620.2,
        quantityBtc: 0.05,
        notionalUsd: 5_936.73,
        marginUsd: 1_978.91,
        leverage: 3,
        unrealizedPnlUsd: randomUnrealizedPnlUsd(),
        feesUsd: 2.97,
        fundingUsd: randomFundingUsd(),
        liquidationPriceUsd: 158_312.66
      }
    ]
  }
];

function randomUsd(min: number, max: number): number {
  return Number((Math.random() * (max - min) + min).toFixed(2));
}
