import { formatBtc, formatSignedUsd, formatUsd } from '../dashboard-formatters.js';
import type { OperationLeg } from '../operations.js';
import { LegStat } from './LegStat.js';

interface OperationLegPanelProps {
  leg: OperationLeg;
}

export function OperationLegPanel({ leg }: OperationLegPanelProps) {
  const sideTone = leg.side === 'long' ? 'text-profit' : 'text-loss';
  const pnlTone = leg.unrealizedPnlUsd >= 0 ? 'border-profit-border bg-profit-surface/60 text-profit' : 'border-loss-border bg-loss-surface/60 text-loss';

  return (
    <section className="bg-panel p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-slate-500">{leg.exchangeId}</p>
          <h4 className={`mt-1 text-xl font-semibold capitalize ${sideTone}`}>{leg.side}</h4>
        </div>
        <div className={`rounded-2xl border px-4 py-3 text-right text-sm ${pnlTone}`}>
          <p className="text-slate-400">Leg PnL</p>
          <p className="text-lg font-bold">{formatSignedUsd(leg.unrealizedPnlUsd)}</p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
        <LegStat label="Entry" value={formatUsd(leg.entryPriceUsd)} />
        <LegStat label="Mark" value={formatUsd(leg.markPriceUsd)} />
        <LegStat label="Size" value={`${formatBtc(leg.quantityBtc)} BTC`} />
        <LegStat label="Notional" value={formatUsd(leg.notionalUsd)} />
        <LegStat label="Margin" value={formatUsd(leg.marginUsd)} />
        <LegStat label="Leverage" value={`${leg.leverage}x`} />
        <LegStat label="Fees" value={formatUsd(leg.feesUsd)} />
        <LegStat label="Funding" value={formatSignedUsd(leg.fundingUsd)} />
        {leg.liquidationPriceUsd ? <LegStat label="Liquidation" value={formatUsd(leg.liquidationPriceUsd)} /> : null}
      </dl>
    </section>
  );
}
