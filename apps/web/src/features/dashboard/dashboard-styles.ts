import type { Tone } from './dashboard-types.js';

export function toneClass(tone: Tone): string {
  if (tone === 'positive') return 'text-profit';
  if (tone === 'negative') return 'text-loss';
  return 'text-slate-100';
}

export function summaryCardClass(tone: Tone): string {
  if (tone === 'positive') return 'border-profit-border/60 bg-profit-surface/45';
  if (tone === 'negative') return 'border-loss-border/60 bg-loss-surface/45';
  return 'border-panel-border bg-panel-muted/70';
}

export function pnlCardClass(tone: Tone): string {
  if (tone === 'positive') return 'border-profit-border/70 bg-profit-surface/60';
  if (tone === 'negative') return 'border-loss-border/70 bg-loss-surface/60';
  return 'border-panel-border bg-panel';
}
