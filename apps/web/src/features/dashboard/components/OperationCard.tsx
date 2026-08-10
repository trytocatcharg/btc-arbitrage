import type { FC } from 'react';
import { formatDateTime, formatSignedUsd, formatUsd } from '../dashboard-formatters.js';
import { calculateOperationPnl, isProfitable, type ArbitrageOperation } from '../operations.js';
import { OperationLegPanel } from './OperationLegPanel.js';
import { StatusBadge } from './StatusBadge.js';
import { SummaryItem } from './SummaryItem.js';

interface OperationCardProps {
  operation: ArbitrageOperation;
}

export const OperationCard: FC<OperationCardProps> = ({ operation }) => {
  const pnl = calculateOperationPnl(operation);
  const profitable = isProfitable(pnl);

  return (
    <article className={`overflow-hidden rounded-3xl border bg-panel shadow-2xl shadow-slate-950/40 ${profitable ? 'border-profit-border/60' : 'border-loss-border/60'}`}>
      <header className="border-b border-panel-border bg-panel-muted/70 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{operation.symbol}</h3>
              <StatusBadge status={operation.status} />
              <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">{operation.mode}</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Opened {formatDateTime(operation.openedAt)} · Updated {formatDateTime(operation.updatedAt)}
            </p>
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-3 lg:min-w-[520px]">
            <SummaryItem label="Entry spread" value={formatUsd(operation.spreadAtEntryUsd)} />
            <SummaryItem label="Threshold" value={formatUsd(operation.thresholdUsd)} />
            <SummaryItem label="Net PnL" value={formatSignedUsd(pnl.netPnlUsd)} tone={profitable ? 'positive' : 'negative'} />
          </div>
        </div>
      </header>

      <div className="grid gap-px bg-slate-800 lg:grid-cols-2">
        {operation.legs.map((leg) => (
          <OperationLegPanel key={`${operation.id}-${leg.exchangeId}-${leg.side}`} leg={leg} />
        ))}
      </div>

      <footer className="grid gap-3 border-t border-panel-border bg-panel-muted/60 p-5 text-sm md:grid-cols-4">
        <SummaryItem label="Gross PnL" value={formatSignedUsd(pnl.grossPnlUsd)} tone={pnl.grossPnlUsd >= 0 ? 'positive' : 'negative'} />
        <SummaryItem label="Fees" value={formatUsd(pnl.feesUsd)} tone="negative" />
        <SummaryItem label="Funding" value={formatSignedUsd(pnl.fundingUsd)} tone={pnl.fundingUsd >= 0 ? 'positive' : 'negative'} />
        <SummaryItem label="Result" value={profitable ? 'Profitable' : 'Not profitable'} tone={profitable ? 'positive' : 'negative'} />
      </footer>
    </article>
  );
};
