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

/**
 * True once Build Report has already produced an artifact for this report.
 * Drives Analytics Preview's action button: re-entering the page (e.g. via
 * Back from PDF Preview) must show "View Report Preview" (pure navigation)
 * rather than "Build Report" again, so re-entry never re-fires a build.
 */
export function isReportAlreadyBuilt(status: ReportStatus): boolean {
  return status !== 'PENDING_ANALYSIS' && status !== 'ANALYSIS_FAILED' && status !== 'ANALYSIS_READY';
}

/**
 * The backend's generate-email-draft only accepts REPORT_READY (see
 * markEmailDrafted's guard). Drives PDF Report Preview's "Next: Email"
 * button: once a draft already exists (any later status), re-entering this
 * page and clicking Next: Email again must resume on the existing draft via
 * pure navigation, not re-call the draft generator and hit an
 * invalid-transition error.
 */
export function canGenerateEmailDraft(status: ReportStatus): boolean {
  return status === 'REPORT_READY';
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

/**
 * FIX #4: what the Email Draft Save Changes button should say. `saving` wins
 * over everything (a request is in flight); "Saved" only shows right after
 * a successful save AND while the form still matches what was persisted --
 * the moment the user edits anything again (isDirty flips true) it reverts
 * to the default label, so "Saved" never lingers on top of new unsaved
 * edits. Never returns "Saved" while `saving` or on an error path -- the
 * caller only passes `justSaved: true` inside the save handler's success
 * branch, never on failure.
 */
export function resolveSaveButtonLabel({
  saving,
  justSaved,
  isDirty,
}: {
  saving: boolean;
  justSaved: boolean;
  isDirty: boolean;
}): string {
  if (saving) return 'Saving...';
  if (justSaved && !isDirty) return 'Saved';
  return 'Save Changes';
}
