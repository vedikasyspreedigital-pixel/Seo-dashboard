import type { RunStatus } from '../../api/types';

export type ToastTone = 'success' | 'warning' | 'neutral';

export interface RunCompletionNotification {
  message: string;
  tone: ToastTone;
}

const TERMINAL_STATUSES = new Set<RunStatus>(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);

/**
 * Pure decision of whether a run-status transition (as observed by
 * useRunProgress's poll) should surface a completion toast, and what it
 * should say. Fires only on the actual edge into a terminal state from a
 * non-terminal one -- never on the very first poll (previousStatus === null,
 * which would otherwise fire for a run that was already finished before the
 * page was opened) and never again once already terminal (StrictMode's
 * double-invoke, or a stray extra poll, must not double-toast).
 */
export function resolveRunCompletionNotification(
  previousStatus: RunStatus | null,
  nextStatus: RunStatus,
  sourceFilename: string,
): RunCompletionNotification | null {
  if (previousStatus === null) return null;
  if (TERMINAL_STATUSES.has(previousStatus)) return null;
  if (!TERMINAL_STATUSES.has(nextStatus)) return null;

  switch (nextStatus) {
    case 'COMPLETED':
      return { message: `Run completed: ${sourceFilename}`, tone: 'success' };
    case 'COMPLETED_WITH_ERRORS':
      return { message: `Run completed with errors: ${sourceFilename}`, tone: 'warning' };
    case 'CANCELLED':
      return { message: `Run cancelled: ${sourceFilename}`, tone: 'neutral' };
    default:
      return null;
  }
}
