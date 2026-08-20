import type { FC } from 'react';
import type { ExchangeBalance, ExchangeBalanceStatus } from '@btc-arbitrage/domain';
import { formatDateTime, formatNullableUsd } from '../dashboard-formatters.js';
import type { Tone } from '../dashboard-types.js';

interface ExchangeBalanceCardProps {
  title: string;
  balance?: ExchangeBalance;
  loading: boolean;
}

export const ExchangeBalanceCard: FC<ExchangeBalanceCardProps> = ({ title, balance, loading }) => {
  const status = loading ? 'loading' : (balance?.status ?? 'unconfigured');
  const tone = getStatusTone(status);

  return (
    <article className="rounded-3xl border border-panel-border bg-panel-muted/80 p-5 shadow-xl shadow-slate-950/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Exchange balance</p>
          <h2 className="mt-2 text-xl font-semibold">{title}</h2>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs uppercase tracking-[0.18em] ${getStatusClass(tone)}`}>{status}</span>
      </div>

      <p className="mt-5 text-sm text-slate-400">Total equity</p>
      <p className="mt-1 text-lg font-bold text-slate-50">{loading ? 'Loading…' : formatNullableUsd(balance?.totalEquityUsd)}</p>

      <p className="mt-5 text-sm text-slate-400">Available</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{loading ? 'Loading…' : formatNullableUsd(balance?.availableUsd)}</p>

      {balance?.receivedAt ? <p className="mt-4 text-xs text-slate-500">Updated {formatDateTime(balance.receivedAt)}</p> : null}
    </article>
  );
};

function getStatusTone(status: ExchangeBalanceStatus | 'loading'): Tone {
  if (status === 'available') return 'positive';
  if (status === 'error') return 'negative';
  return 'neutral';
}

function getStatusClass(tone: Tone): string {
  if (tone === 'positive') return 'border-profit-border/70 bg-profit-surface/50 text-profit';
  if (tone === 'negative') return 'border-loss-border/70 bg-loss-surface/50 text-loss';
  return 'border-slate-700 bg-slate-900/70 text-slate-400';
}
