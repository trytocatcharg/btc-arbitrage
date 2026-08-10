import { summaryCardClass, toneClass } from '../dashboard-styles.js';
import type { Tone } from '../dashboard-types.js';

interface SummaryItemProps {
  label: string;
  value: string;
  tone?: Tone;
}

export function SummaryItem({ label, value, tone = 'neutral' }: SummaryItemProps) {
  return (
    <div className={`rounded-2xl border p-3 ${summaryCardClass(tone)}`}>
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className={`mt-1 font-semibold ${toneClass(tone)}`}>{value}</p>
    </div>
  );
}
