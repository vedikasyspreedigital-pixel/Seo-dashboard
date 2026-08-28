import type { ReportStatus } from '../../api/types';

// Pure business-rule helpers for the report approval flow -- kept dependency-
// free (no React, no fetch) so they can be unit tested directly and so the
// UI components stay thin wrappers around these decisions.

export function isDraftEditable(status: ReportStatus): boolean {
  return status === 'PENDING_APPROVAL';
}

export function canRegenerate(status: ReportStatus): boolean {
  return status === 'PENDING_APPROVAL';
}

export function canApproveOrReject(status: ReportStatus): boolean {
  return status === 'PENDING_APPROVAL';
}

export function canDownloadReport(reportHtml: string | null | undefined): boolean {
  return typeof reportHtml === 'string' && reportHtml.length > 0;
}

export function isReportFailed(status: ReportStatus): boolean {
  return status === 'ANALYSIS_FAILED' || status === 'EMAIL_DRAFT_FAILED';
}

export function buildReportDownloadFilename(report: { id: string; runId: string }): string {
  return `ranking-report-${report.runId}-${report.id.slice(0, 8)}.html`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export interface ParsedRecipients {
  recipients: string[];
  invalid: string[];
}

/** Splits a comma-separated recipients field into valid/invalid buckets -- never silently drops a bad entry, so the UI can flag it before Save is allowed. */
export function parseRecipientsInput(value: string): ParsedRecipients {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const recipients: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (isValidEmailAddress(part)) recipients.push(part);
    else invalid.push(part);
  }
  return { recipients, invalid };
}
