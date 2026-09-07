import type { ReportStatus } from '../../api/types';

/**
 * The single canonical "what page is this report status for" resolver.
 * Used two ways: (1) entry points (Reports list, re-creating a report for a
 * run that already has one) route straight to whichever step the report has
 * actually reached; (2) a wizard page whose data prerequisite isn't met yet
 * (e.g. /preview with no clientPdfPath) redirects here instead of showing a
 * broken page. Never used to bounce a user forward off a page they
 * intentionally navigated Back to -- going back never un-sets the data a
 * page needs, so it never triggers case (2).
 */
export function resumeRouteForStatus(reportId: string, status: ReportStatus): string {
  switch (status) {
    case 'PENDING_ANALYSIS':
    case 'ANALYSIS_FAILED':
    case 'ANALYSIS_READY':
      return `/reports/${reportId}/analytics`;
    case 'REPORT_READY':
      return `/reports/${reportId}/preview`;
    case 'EMAIL_DRAFT_FAILED':
    case 'EMAIL_DRAFTED':
    case 'PENDING_APPROVAL':
      return `/reports/${reportId}/email`;
    default: // APPROVED, REJECTED, SENT
      return `/reports/${reportId}/send`;
  }
}
