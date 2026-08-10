import type { FC } from 'react';

interface LegStatProps {
  label: string;
  value: string;
}

export const LegStat: FC<LegStatProps> = ({ label, value }) => {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-100">{value}</dd>
    </div>
  );
};
