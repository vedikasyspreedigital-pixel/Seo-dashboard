export class InvalidReportTransitionError extends Error {
  reportId: string;

  constructor(reportId: string, attemptedAction: string) {
    super(`Report ${reportId}: cannot ${attemptedAction} -- not in a valid current state`);
    this.name = "InvalidReportTransitionError";
    this.reportId = reportId;
  }
}
