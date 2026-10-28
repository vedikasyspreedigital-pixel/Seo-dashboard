import { Spinner } from '../ui/Spinner';

export type PartState = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'idle';

/** One small status mark used by the Run-all rows and the audit cards. */
export function StatusDot({ state }: { state: PartState }) {
  if (state === 'running' || state === 'queued') return <Spinner className="h-4 w-4 text-brand-300" />;
  const mark: Record<string, { text: string; cls: string; label: string }> = {
    done: { text: '✓', cls: 'bg-emerald-500/15 text-emerald-300', label: 'Done' },
    failed: { text: '!', cls: 'bg-amber-500/15 text-amber-300', label: 'Failed' },
    skipped: { text: '–', cls: 'bg-overlay/[0.06] text-[var(--color-ink-faint)]', label: 'Skipped' },
    waiting: { text: '', cls: 'border border-[var(--color-border-strong)]', label: 'Waiting' },
    idle: { text: '', cls: 'border border-[var(--color-border-strong)]', label: 'Not run yet' },
  };
  const m = mark[state] ?? mark.waiting;
  return (
    <span role="img" aria-label={m.label} className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${m.cls}`}>
      {m.text}
    </span>
  );
}
