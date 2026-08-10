import type { FC } from 'react';
import { ExecutionMode } from '@btc-arbitrage/domain';

interface EmptyStateProps {
  executionMode: ExecutionMode;
}

export const EmptyState: FC<EmptyStateProps> = ({ executionMode }) => {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <h3 className="text-lg font-semibold">No open operations</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
        {executionMode === ExecutionMode.DryRun
          ? 'Dry-run mock operations are empty.'
          : 'Live mode will show operations from the read-only bot API once persistence endpoints are connected.'}
      </p>
    </div>
  );
};
