export type RunStatus = 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'CANCELLED';
export type RowStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR_RETRY' | 'FAILED';

export interface ClientRecord {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  // Only present when fetched via getClientsForManagement (includeInactive)
  // -- the plain dropdown-backing getClients() response omits these.
  workspaceId?: string | null;
  notes?: string | null;
  archivedAt?: string | null;
  clickupTaskId?: string | null;
  clickupTaskUrl?: string | null;
}

export interface CreateClientInput {
  workspaceId: string;
  name: string;
  clickupTaskId?: string;
  clickupTaskUrl?: string;
  notes?: string;
}

export interface UpdateClientInput {
  name?: string;
  notes?: string;
  clickupTaskId?: string;
  clickupTaskUrl?: string;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface SessionInfo {
  user: UserRecord;
  workspaces: WorkspaceRecord[];
}

export interface RankingRun {
  id: string;
  clientId: string;
  // The run's OWN client -- present on GET /runs/:id (which includes it),
  // absent on GET /runs?clientId= (list already scoped to one known
  // client, so it's redundant per-row there). Optional, not required, to
  // honestly reflect that. Wherever shown, must be used instead of the
  // currently-active client from ClientContext, which can differ if the
  // user switches clients while still viewing this run.
  client?: { name: string };
  sourceFilename: string;
  status: RunStatus;
  totalRows: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface OverviewRecentRun {
  id: string;
  clientName: string;
  sourceFilename: string;
  status: RunStatus;
  totalRows: number;
  createdAt: string;
  completedAt: string | null;
}

export interface OverviewData {
  totalClients: number;
  totalRuns: number;
  totalSuccessfulRuns: number;
  totalKeywordsTracked: number;
  top3Count: number;
  top10Count: number;
  notIn100Count: number;
  averageRank: number | null;
  rankingMovements: { improved: number; declined: number; unchanged: number };
  dailyMovements: { date: string; improved: number; declined: number; unchanged: number }[];
  recentRuns: OverviewRecentRun[];
}

export interface RunRow {
  id: string;
  sourceRowNumber: number;
  keyword: string;
  locationName: string;
  languageName: string;
  status: RowStatus;
  rankDisplay: string | null;
  rankingUrl: string | null;
}

export interface ValidateRunFileResult {
  insertedRowCount: number;
  rowErrorCount: number;
  rowErrors: RowError[];
  detectedColumns: string[];
  fileSizeBytes: number;
}

export interface RunProgress {
  runStatus: RunStatus;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  errorRetry: number;
  failed: number;
}

export interface RowError {
  sourceRowNumber: number;
  reason: string;
}

export interface CreateRunResult {
  run: RankingRun;
  insertedRowCount: number;
  rowErrors: RowError[];
}

export type ReportStatus =
  | 'PENDING_ANALYSIS'
  | 'ANALYSIS_FAILED'
  | 'ANALYSIS_READY'
  | 'REPORT_READY'
  | 'EMAIL_DRAFT_FAILED'
  | 'EMAIL_DRAFTED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENDING'
  | 'REJECTED'
  | 'SENT';

// Mirrors backend/reporting/computeRunAnalytics.ts's RunAnalytics exactly --
// pure backend output, never touched by Claude.
export interface RunAnalyticsTotals {
  totalKeywords: number;
  averageRank: number | null;
  top3Count: number;
  top10Count: number;
  notIn100Count: number;
}

export interface KeywordMovement {
  keyword: string;
  rowUid: string;
  previousRank: number | null;
  currentRank: number | null;
  delta: number | null;
}

export interface NewlyTrackedKeyword {
  keyword: string;
  rowUid: string;
  currentRank: number | null;
}

export interface RunAnalytics {
  runId: string;
  previousRunId: string | null;
  totals: RunAnalyticsTotals;
  movements: {
    improved: KeywordMovement[];
    declined: KeywordMovement[];
    unchanged: KeywordMovement[];
    newlyTracked: NewlyTrackedKeyword[];
  };
}

// Legacy shape for RankingReport.analysisJson -- this app has no AI analysis
// step anymore, so every report's analysisJson is permanently null going
// forward. Kept only so the type still matches what the backend can return
// for historical rows from before this was removed.
export interface AnalystOutput {
  overallNarrative: string;
  keyInsights: string[];
  notableWins: { keyword: string; note: string }[];
  notableLosses: { keyword: string; note: string }[];
  recommendedFocusAreas: string[];
}

export interface RankingReport {
  id: string;
  runId: string;
  previousRunId: string | null;
  clientId: string;
  status: ReportStatus;
  analyticsJson: RunAnalytics | null;
  analysisJson: AnalystOutput | null;
  reportHtml: string | null;
  clientPdfPath: string | null;
  /** "generated" | "custom" -- which PDF approveAndSendReport actually attaches. Switching this never deletes/replaces clientPdfPath or customPdfPath. */
  attachmentSource: string;
  customPdfPath: string | null;
  /** Original uploaded filename -- shown in the UI and used as the attachment's display name when sending, since customPdfPath itself is a generated on-disk name. */
  customPdfFilename: string | null;
  emailSubject: string | null;
  emailBody: string | null;
  emailBodyHtml: string | null;
  resolvedRecipients: string[] | null;
  resolvedCc: string[] | null;
  resolvedClickupTaskUrl: string | null;
  lastErrorMessage: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  /** null = not applicable/unknown (sent before this existed, or a sender with no audit-comment step). false = the email genuinely sent, but the follow-up ClickUp audit-trail comment failed -- never means the send itself failed. */
  auditCommentPosted: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface RankingReportListItem extends RankingReport {
  run: Pick<RankingRun, 'id' | 'sourceFilename' | 'createdAt'>;
}

export type NotificationType = 'RUN_COMPLETED' | 'RUN_COMPLETED_WITH_ERRORS' | 'REPORT_SENT' | 'REPORT_SEND_FAILED';

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  type: NotificationType;
  message: string;
  clientId: string | null;
  runId: string | null;
  reportId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: NotificationRecord[];
  unreadCount: number;
}

export type BaselineSourceType = 'EXCEL' | 'PDF';

export interface BaselinePreviewRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

export interface BaselinePreview {
  detectedDates: { label: string; isoDate: string }[];
  baselineDate: string;
  baselineDateLabel: string;
  rows: BaselinePreviewRow[];
  sourceFilename: string;
  sourceType: BaselineSourceType;
}

export interface BaselineRecord {
  id: string;
  sourceFilename: string;
  sourceType: BaselineSourceType;
  baselineDate: string;
  createdAt: string;
  rowCount: number;
}
