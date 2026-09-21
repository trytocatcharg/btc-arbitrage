import type { FC } from "react";
import { formatDateTime, formatUsd } from "../dashboard-formatters.js";
import type { VolumeStatsState } from "../volume-stats.js";
import { MetricCard } from "./MetricCard.js";
import { StatusBadge } from "./StatusBadge.js";
import { SummaryItem } from "./SummaryItem.js";

interface FarmedVolumePanelProps {
  volumeStats: VolumeStatsState;
}

/**
 * Farmed trading volume (volume-farming spec): lifetime total, trailing
 * 24h / 7d / 30d totals, and the per-venue breakdown, all read-only from
 * `GET /api/trades/volume-stats`. When the DB holds zeros (dry-run / pre-fill)
 * the panel renders an explicit "$0.00 farmed" empty state — never an error.
 * A backend outage degrades to a muted note so the rest of the dashboard
 * (balances) still renders.
 */
export const FarmedVolumePanel: FC<FarmedVolumePanelProps> = ({
  volumeStats,
}) => {
  if (volumeStats.error) {
    return (
      <section className="rounded-3xl border border-panel-border bg-panel/60 p-5 text-sm text-slate-500">
        Farmed volume unavailable ({volumeStats.error}) — showing balances only.
      </section>
    );
  }

  if (volumeStats.loading || !volumeStats.stats) {
    return (
      <section className="rounded-3xl border border-panel-border bg-panel p-5">
        <h2 className="text-xl font-semibold">Farmed volume</h2>
        <p className="mt-3 text-sm text-slate-400">Loading…</p>
      </section>
    );
  }

  const { lifetime, windows, generatedAt } = volumeStats.stats;
  const lifetimeUsd = Number(lifetime.totalUsd);
  const hasVolume = Number.isFinite(lifetimeUsd) && lifetimeUsd > 0;

  return (
    <section className="rounded-3xl border border-panel-border bg-panel p-6 shadow-2xl shadow-slate-950/50">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
            Volume farming
          </p>
          <h2 className="mt-2 text-xl font-semibold">Farmed volume</h2>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[0.65rem] uppercase tracking-[0.18em] text-slate-500">
            Farming
          </span>
          <StatusBadge status={hasVolume ? "open" : "planned"} />
        </div>
      </div>

      {hasVolume ? null : (
        <p className="mt-5 text-lg font-semibold text-slate-200">
          {formatUsd(0)} farmed
        </p>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Lifetime farmed"
          value={formatUsd(lifetimeUsd)}
          tone="positive"
          emphasis
        />
        <MetricCard
          label="Last 24h"
          value={formatUsd(Number(windows["24h"].totalUsd))}
        />
        <MetricCard
          label="Last 7d"
          value={formatUsd(Number(windows["7d"].totalUsd))}
        />
        <MetricCard
          label="Last 30d"
          value={formatUsd(Number(windows["30d"].totalUsd))}
        />
      </div>

      <div className="mt-5">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
          Per-venue breakdown (lifetime)
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {lifetime.byVenue.length > 0 ? (
            lifetime.byVenue.map((venue) => (
              <SummaryItem
                key={venue.exchangeId}
                label={venue.exchangeId}
                value={formatUsd(Number(venue.volumeUsd))}
              />
            ))
          ) : (
            <SummaryItem label="No venue volume yet" value={formatUsd(0)} />
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Updated {formatDateTime(generatedAt)}
      </p>
    </section>
  );
};
