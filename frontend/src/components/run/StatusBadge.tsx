import { StatusBadge as GenericStatusBadge } from '../ui/StatusBadge';

type Status = 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'CANCELLED' | 'PENDING' | 'ERROR_RETRY' | 'FAILED';

const STYLES: Record<Status, string> = {
  UPLOADED: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
  PENDING: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
  PROCESSING: 'bg-blue-500/10 text-blue-300',
  COMPLETED: 'bg-emerald-500/15 text-emerald-300',
  COMPLETED_WITH_ERRORS: 'bg-amber-500/10 text-amber-300',
  ERROR_RETRY: 'bg-amber-500/10 text-amber-300',
  FAILED: 'bg-rose-500/10 text-rose-300',
  CANCELLED: 'bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]',
};

const LABELS: Record<Status, string> = {
  UPLOADED: 'Uploaded',
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with errors',
  ERROR_RETRY: 'Error - Retry',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export function StatusBadge({ status }: { status: string }) {
  const key = (status in STYLES ? status : 'PENDING') as Status;
  return <GenericStatusBadge label={LABELS[key]} toneClassName={STYLES[key]} mono />;
}
