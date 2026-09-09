import type { ReportStatus } from '../../api/types';
import { StatusBadge } from '../ui/StatusBadge';

// Deliberately separate from run/StatusBadge.tsx: the reporting state
// machine is isolated from RunStatus/RowStatus on the backend, so it gets
// its own small status-to-tone/label map here rather than widening that
// component's type -- both build on the same shared ui/StatusBadge primitive.

const STYLES: Record<ReportStatus, string> = {
  PENDING_ANALYSIS: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
  ANALYSIS_FAILED: 'bg-rose-500/10 text-rose-300',
  ANALYSIS_READY: 'bg-blue-500/10 text-blue-300',
  REPORT_READY: 'bg-blue-500/10 text-blue-300',
  EMAIL_DRAFT_FAILED: 'bg-rose-500/10 text-rose-300',
  EMAIL_DRAFTED: 'bg-blue-500/10 text-blue-300',
  PENDING_APPROVAL: 'bg-amber-500/10 text-amber-300',
  APPROVED: 'bg-brand-400/15 text-brand-300',
  SENDING: 'bg-amber-500/10 text-amber-300',
  REJECTED: 'bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]',
  SENT: 'bg-brand-400/15 text-brand-300',
};

const LABELS: Record<ReportStatus, string> = {
  PENDING_ANALYSIS: 'Analyzing',
  ANALYSIS_FAILED: 'Analysis failed',
  ANALYSIS_READY: 'Analysis ready',
  REPORT_READY: 'Report ready',
  EMAIL_DRAFT_FAILED: 'Draft failed',
  EMAIL_DRAFTED: 'Drafted',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  SENDING: 'Sending…',
  REJECTED: 'Rejected',
  SENT: 'Sent',
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return <StatusBadge label={LABELS[status]} toneClassName={STYLES[status]} />;
}
