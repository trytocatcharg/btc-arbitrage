import type { FC } from 'react';
import type { ArbitrageOperation } from '../operations.js';

interface StatusBadgeProps {
  status: ArbitrageOperation['status'];
}

export const StatusBadge: FC<StatusBadgeProps> = ({ status }) => {
  return <span className="rounded-full bg-cyan-950 px-2.5 py-1 text-xs font-medium text-cyan-200">{status}</span>;
};
