import type { ArbitrageOperation } from '../operations.js';

interface StatusBadgeProps {
  status: ArbitrageOperation['status'];
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className="rounded-full bg-cyan-950 px-2.5 py-1 text-xs font-medium text-cyan-200">{status}</span>;
}
