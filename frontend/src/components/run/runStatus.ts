import type { RunStatus } from '../../api/types';

// Pure business-rule helpers for the Run Detail action area -- kept
// dependency-free (no React, no fetch) so they can be unit tested directly,
// matching the convention in components/report/reportStatus.ts. Backed
// entirely by the RunStatus the backend returns (via GET /:id/progress,
// polled by useRunProgress) -- never by progress percentage, row counts, or
// any other frontend-computed signal.

/**
 * Whether a run's Excel/report artifacts are ready to act on. This is the
 * app's one existing "reportable/downloadable" definition (already used to
 * gate the Generate Report button) -- Download Excel now uses the exact
 * same definition, so a CANCELLED run (terminal, but never completed) shows
 * neither action, only COMPLETED and COMPLETED_WITH_ERRORS do.
 */
export function isRunReportable(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'COMPLETED_WITH_ERRORS';
}

/** Whether the run is still in a state cancelRun's own guard actually accepts (UPLOADED | PROCESSING) -- mirrors backend/statemachine/runTransitions.js's cancelRun exactly, unchanged. */
export function isRunCancelable(status: RunStatus): boolean {
  return status === 'UPLOADED' || status === 'PROCESSING';
}
