import { CheckCircleIcon } from '../ui/icons';
import type { RunStatus } from '../../api/types';

const TONE: Record<string, { badge: string; text: string; label: string }> = {
  COMPLETED: { badge: 'bg-brand-400/15 text-brand-300', text: 'text-brand-300', label: 'Completed' },
  COMPLETED_WITH_ERRORS: { badge: 'bg-amber-500/15 text-amber-300', text: 'text-amber-300', label: 'Completed with errors' },
  CANCELLED: { badge: 'bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]', text: 'text-[var(--color-ink-faint)]', label: 'Cancelled' },
};

interface Props {
  status: RunStatus;
  totalRows: number;
  failedCount: number;
  completedAt: string | null;
}

/** Replaces the file-info card once a run reaches a terminal state -- the
 * outcome (completed/failed counts) matters more than the source file at
 * that point, matching the reference's terminal-state layout. */
export function CompletedSummary({ status, totalRows, failedCount, completedAt }: Props) {
  const tone = TONE[status] ?? TONE.COMPLETED;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full ${tone.badge}`}>
          <CheckCircleIcon className="h-4 w-4" />
        </span>
        <span className={`font-semibold ${tone.text}`}>
          {tone.label} &mdash; {totalRows} row{totalRows === 1 ? '' : 's'} &middot; {failedCount} failed
        </span>
      </div>
      {completedAt && (
        <span className="font-mono text-sm text-[var(--color-ink-faint)]">
          {new Date(completedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} &middot;{' '}
          {new Date(completedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}
