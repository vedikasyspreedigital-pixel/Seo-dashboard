import { Card } from './Card';

interface Props {
  label: string;
  value: string | number;
  accent?: string;
}

/** A single label+value stat card -- reused across run progress, run
 * completion summary, and the report wizard's analytics/movements rows. */
export function StatTile({ label, value, accent = 'text-[var(--color-ink)]' }: Props) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">{label}</p>
      <p className={`mt-1.5 font-mono text-[28px] font-bold leading-none tabular-nums ${accent}`}>{value}</p>
    </Card>
  );
}
