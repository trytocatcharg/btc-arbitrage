import { useEffect, useState, type FC } from 'react';
import { ExecutionMode } from '@btc-arbitrage/domain';
import { mockOpenOperations } from './mock-operations.js';
import { EmptyState } from './components/EmptyState.js';
import { ExchangeBalanceCard } from './components/ExchangeBalanceCard.js';
import { MetricCard } from './components/MetricCard.js';
import { OperationCard } from './components/OperationCard.js';
import { formatNullableUsd, formatSignedUsd } from './dashboard-formatters.js';
import { fetchExchangeBalances, findExchangeBalance, type ExchangeBalancesState } from './exchange-balances.js';
import { calculateOperationPnl } from './operations.js';

const executionMode = getExecutionMode();
const openOperations = executionMode === ExecutionMode.DryRun ? mockOpenOperations : [];
const portfolioPnl = openOperations.reduce((total, operation) => total + calculateOperationPnl(operation).netPnlUsd, 0);

export const Dashboard: FC = () => {
  const [exchangeBalances, setExchangeBalances] = useState<ExchangeBalancesState>({
    balances: [],
    loading: true,
    total: null
  });

  useEffect(() => {
    let isMounted = true;

    const refreshBalances = async () => {
      try {
        const response = await fetchExchangeBalances();
        if (!isMounted) return;
        setExchangeBalances({
          balances: response.balances,
          generatedAt: response.generatedAt,
          loading: false,
          total: response.total
        });
      } catch (error: unknown) {
        if (!isMounted) return;
        setExchangeBalances({
          balances: [],
          loading: false,
          total: null,
          error: error instanceof Error ? error.message : 'Could not load exchange balances'
        });
      }
    };

    void refreshBalances();
    const intervalId = window.setInterval(refreshBalances, 30_000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const risexBalance = findExchangeBalance(exchangeBalances.balances, 'risex');
  const extendedBalance = findExchangeBalance(exchangeBalances.balances, 'extended');

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(260px,300px)_minmax(260px,300px)]">
        <div className="rounded-3xl border border-panel-border bg-panel/85 p-6 shadow-2xl shadow-slate-950/50 backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">Read-only dashboard</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight">BTC Arbitrage Operations</h1>
              <p className="mt-4 max-w-3xl text-slate-300">
                Monitor open arbitrage operations across both exchange legs. The net PnL includes unrealized PnL, fees,
                and funding so the dashboard shows whether the hedge is actually profitable.
              </p>
            </div>
            <div className="rounded-2xl border border-panel-border bg-panel-muted/90 p-4 text-sm shadow-inner">
              <p className="text-slate-400">Total</p>
              <p className="mt-1 text-xl font-semibold text-cyan-200">{formatNullableUsd(exchangeBalances.total)}</p>

            </div>
          </div>
        </div>

        <ExchangeBalanceCard title="RISEx" balance={risexBalance} loading={exchangeBalances.loading} />
        <ExchangeBalanceCard title="Extended" balance={extendedBalance} loading={exchangeBalances.loading} />
      </section>

      {exchangeBalances.error ? (
        <section className="mt-4 rounded-3xl border border-loss-border/70 bg-loss-surface/50 p-5 text-sm text-loss">
          Backend balances unavailable: {exchangeBalances.error}
        </section>
      ) : null}

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        <MetricCard label="Open operations" value={String(openOperations.length)} />
        <MetricCard label="Net open PnL" value={formatSignedUsd(portfolioPnl)} tone={portfolioPnl >= 0 ? 'positive' : 'negative'} emphasis />
        <MetricCard label="History" value="Coming soon" />
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Open operations</h2>
            <p className="mt-1 text-sm text-slate-400">Each operation shows both exchange legs and the final net result.</p>
          </div>
        </div>

        {openOperations.length > 0 ? (
          <div className="space-y-5">
            {openOperations.map((operation) => (
              <OperationCard key={operation.id} operation={operation} />
            ))}
          </div>
        ) : (
          <EmptyState executionMode={executionMode} />
        )}
      </section>

      <section className="mt-8 rounded-3xl border border-dashed border-panel-border bg-panel/40 p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Historical operations</h2>
            <p className="mt-1 text-sm text-slate-400">
              This section is reserved for closed trades, realized PnL, entry/exit prices, fees, and close reasons.
            </p>
          </div>
          <span className="rounded-full border border-slate-700 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-400">Later</span>
        </div>
      </section>
    </main>
  );
};

function getExecutionMode(): ExecutionMode {
  return import.meta.env.BOT_EXECUTION_MODE === ExecutionMode.Live ? ExecutionMode.Live : ExecutionMode.DryRun;
}
