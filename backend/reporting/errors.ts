export class InvalidReportTransitionError extends Error {
  reportId: string;

  constructor(reportId: string, attemptedAction: string) {
    super(`Report ${reportId}: cannot ${attemptedAction} -- not in a valid current state`);
    this.name = "InvalidReportTransitionError";
    this.reportId = reportId;
  }
}

/** Thrown by updateReportDraft's Save Changes guard when this report's date range matches one already SENT for the same client -- see findDuplicateDatedReport. */
export class DuplicateReportDateError extends Error {
  reportId: string;
  conflictingReportId: string;

  constructor(reportId: string, conflictingReportId: string, periodStart: Date, periodEnd: Date) {
    super(
      `A report for this client covering the same date range (${periodStart.toDateString()} - ${periodEnd.toDateString()}) was already sent (report ${conflictingReportId}) -- resolve the duplicate before saving changes here.`,
    );
    this.name = "DuplicateReportDateError";
    this.reportId = reportId;
    this.conflictingReportId = conflictingReportId;
  }
}
