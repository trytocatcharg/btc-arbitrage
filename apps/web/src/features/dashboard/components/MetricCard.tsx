import { pnlCardClass, toneClass } from '../dashboard-styles.js';
import type { Tone } from '../dashboard-types.js';

interface MetricCardProps {
  label: string;
  value: string;
  tone?: Tone;
  emphasis?: boolean;
}

export function MetricCard({ label, value, tone = 'neutral', emphasis = false }: MetricCardProps) {
  return (
    <article className={`rounded-3xl border p-5 shadow-xl shadow-slate-950/30 ${emphasis ? pnlCardClass(tone) : 'border-panel-border bg-panel'}`}>
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${toneClass(tone)}`}>{value}</p>
    </article>
  );
}
