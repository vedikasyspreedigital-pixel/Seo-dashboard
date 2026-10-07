import type {
  BaselinePreview,
  BaselineRecord,
  ClientRecord,
  CreateClientInput,
  CreateRunResult,
  NotificationsResponse,
  OverviewData,
  RankingReport,
  RankingReportListItem,
  RankingRun,
  RunProgress,
  RunRow,
  SessionInfo,
  UpdateClientInput,
  ValidateRunFileResult,
} from './types';

// Local dev: Vite proxies /api to the local backend (same origin), so this
// stays relative. Once the frontend and backend are hosted separately (e.g.
// Vercel + Render), VITE_API_BASE_URL points this at the real backend URL --
// set at build time, baked into the deployed bundle.
const BASE = `${import.meta.env?.VITE_API_BASE_URL ?? ''}/api`;

/**
 * Every request goes through this instead of bare `fetch` so the session
 * cookie is always included -- required once frontend/backend are on
 * separate hosts (cross-origin), harmless as a same-origin default locally.
 * Centralized here rather than added ad hoc per call so no endpoint can
 * accidentally be added later without it.
 */
function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: 'include' });
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// -- Auth / workspace -------------------------------------------------------

export async function login(email: string, password: string): Promise<SessionInfo> {
  const res = await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return handle<SessionInfo>(res);
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

/** Null (not a throw) when there's no valid session -- callers use this to decide whether to show the login page, not to handle an error. */
export async function getMe(): Promise<SessionInfo | null> {
  const res = await apiFetch('/auth/me');
  if (res.status === 401) return null;
  return handle<SessionInfo>(res);
}

export async function getClients(workspaceId: string): Promise<ClientRecord[]> {
  const res = await apiFetch(`/clients?workspaceId=${encodeURIComponent(workspaceId)}`);
  return handle<ClientRecord[]>(res);
}

// -- Client Management ------------------------------------------------------
// Distinct from getClients (the dropdown query): includes inactive clients
// (and, optionally, archived ones) plus each client's ClickUp mapping.

export async function getClientsForManagement(workspaceId: string, options?: { includeArchived?: boolean }): Promise<ClientRecord[]> {
  const params = new URLSearchParams({ workspaceId, includeInactive: 'true' });
  if (options?.includeArchived) params.set('includeArchived', 'true');
  const res = await apiFetch(`/clients?${params.toString()}`);
  return handle<ClientRecord[]>(res);
}

export async function createClient(input: CreateClientInput): Promise<ClientRecord> {
  const res = await apiFetch('/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handle<ClientRecord>(res);
}

export async function updateClient(clientId: string, input: UpdateClientInput): Promise<ClientRecord> {
  const res = await apiFetch(`/clients/${clientId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handle<ClientRecord>(res);
}

export async function activateClient(clientId: string): Promise<ClientRecord> {
  const res = await apiFetch(`/clients/${clientId}/activate`, { method: 'PATCH' });
  return handle<ClientRecord>(res);
}

export async function deactivateClient(clientId: string): Promise<ClientRecord> {
  const res = await apiFetch(`/clients/${clientId}/deactivate`, { method: 'PATCH' });
  return handle<ClientRecord>(res);
}

export async function archiveClient(clientId: string): Promise<ClientRecord> {
  const res = await apiFetch(`/clients/${clientId}/archive`, { method: 'PATCH' });
  return handle<ClientRecord>(res);
}

export async function restoreClient(clientId: string): Promise<ClientRecord> {
  const res = await apiFetch(`/clients/${clientId}/restore`, { method: 'PATCH' });
  return handle<ClientRecord>(res);
}

export async function getOverview(workspaceId: string, clientId?: string): Promise<OverviewData> {
  const params = new URLSearchParams({ workspaceId });
  if (clientId) params.set('clientId', clientId);
  const res = await apiFetch(`/overview?${params.toString()}`);
  return handle<OverviewData>(res);
}

export async function createRun(clientId: string, file: File): Promise<CreateRunResult> {
  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('file', file);
  const res = await apiFetch('/runs', { method: 'POST', body: formData });
  return handle<CreateRunResult>(res);
}

/** Preview only -- parses the file server-side but creates nothing. */
export async function validateRunFile(clientId: string, file: File): Promise<ValidateRunFileResult> {
  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('file', file);
  const res = await apiFetch('/runs/validate', { method: 'POST', body: formData });
  return handle<ValidateRunFileResult>(res);
}

export async function startRun(runId: string): Promise<RankingRun> {
  const res = await apiFetch(`/runs/${runId}/start`, { method: 'POST' });
  return handle<RankingRun>(res);
}

export async function cancelRun(runId: string): Promise<RankingRun> {
  const res = await apiFetch(`/runs/${runId}/cancel`, { method: 'POST' });
  return handle<RankingRun>(res);
}

export async function getRuns(clientId: string): Promise<RankingRun[]> {
  const res = await apiFetch(`/runs?clientId=${encodeURIComponent(clientId)}`);
  return handle<RankingRun[]>(res);
}

export async function deleteRun(runId: string): Promise<void> {
  const res = await apiFetch(`/runs/${runId}`, { method: 'DELETE' });
  if (!res.ok) await handle<never>(res);
}

export async function getRun(runId: string): Promise<RankingRun> {
  const res = await apiFetch(`/runs/${runId}`);
  return handle<RankingRun>(res);
}

export async function getRunRows(runId: string): Promise<RunRow[]> {
  const res = await apiFetch(`/runs/${runId}/rows`);
  return handle<RunRow[]>(res);
}

export async function getRunProgress(runId: string): Promise<RunProgress> {
  const res = await apiFetch(`/runs/${runId}/progress`);
  return handle<RunProgress>(res);
}

export function getExportUrl(runId: string): string {
  return `${BASE}/runs/${runId}/export`;
}

/** Returned when a SENT report would be changed -- the dashboard shows the Continue / Cancel warning. */
export interface ResendInfo {
  sendCount: number;
  lastSentAt: string | null;
}

/** What a (re)generated report compares against, returned alongside it. */
export interface ReportGenerationSummary {
  /** false = the run's first report; true = an existing report was rebuilt in place. */
  regenerated: boolean;
  /** Rows whose rank/status/URL changed with this upload; null for a Regenerate without a file. */
  rowsChanged: number | null;
  previousBaseline: { id: string; baselineDate: string; sourceFilename: string } | null;
}

export interface UploadVerifiedExcelOutcome {
  outcome: 'CREATED' | 'UPDATED' | 'NEEDS_RESEND_CONFIRM' | 'LOCKED' | 'DUPLICATE' | 'RUN_NOT_COMPLETED' | 'UNMATCHED_ROWS' | 'ERROR';
  report?: RankingReport;
  summary?: ReportGenerationSummary;
  /** Only for NEEDS_RESEND_CONFIRM: how often / when the report already went out. */
  resend?: ResendInfo;
  existingReportId?: string;
  unmatchedKeywords?: string[];
  message?: string;
}

/**
 * The new workflow's one upload step: the backend automatically compares
 * this verified Excel against the client's previous verified Excel, builds
 * the PDF, and drafts the email -- no separate Generate Report/Build Report
 * call needed. See backend/reporting/processVerifiedExcelUpload.ts.
 */
export async function uploadVerifiedExcel(runId: string, file: File, options: { confirmResend?: boolean } = {}): Promise<UploadVerifiedExcelOutcome> {
  const formData = new FormData();
  formData.append('file', file);
  if (options.confirmResend) formData.append('confirmResend', 'true');
  const res = await apiFetch(`/runs/${runId}/verified-excel`, { method: 'POST', body: formData });
  const body = await res.json().catch(() => ({}));
  if (res.status === 201 || res.status === 200) {
    return {
      outcome: res.status === 201 ? 'CREATED' : 'UPDATED',
      report: body.report as RankingReport,
      summary: { regenerated: Boolean(body.regenerated), rowsChanged: body.rowsChanged ?? null, previousBaseline: body.previousBaseline ?? null },
    };
  }
  if (res.status === 409 && body.code === 'RESEND_CONFIRMATION_REQUIRED') {
    return { outcome: 'NEEDS_RESEND_CONFIRM', message: body.error, resend: { sendCount: body.sendCount ?? 1, lastSentAt: body.lastSentAt ?? null } };
  }
  // A report being sent, a rejected one, or one a newer report already compares against.
  if (res.status === 409 && typeof body.code === 'string' && body.code !== 'DUPLICATE_REPORT') {
    return { outcome: 'LOCKED', message: body.error, existingReportId: body.existingReportId };
  }
  if (res.status === 409 && typeof body.existingReportId === 'string') {
    return { outcome: 'DUPLICATE', existingReportId: body.existingReportId, message: body.error };
  }
  if (res.status === 409) return { outcome: 'RUN_NOT_COMPLETED', message: body.error };
  if (res.status === 422 && Array.isArray(body.unmatchedKeywords)) {
    return { outcome: 'UNMATCHED_ROWS', unmatchedKeywords: body.unmatchedKeywords, message: body.error };
  }
  return { outcome: 'ERROR', message: body.error ?? `Request failed with status ${res.status}` };
}

// -- Reports --------------------------------------------------------------

export type CreateReportOutcome =
  | { outcome: 'CREATED'; report: RankingReport }
  | { outcome: 'DUPLICATE'; existingReportId: string }
  | { outcome: 'RUN_NOT_FOUND' }
  | { outcome: 'RUN_NOT_COMPLETED'; message: string }
  | { outcome: 'ERROR'; message: string };

/**
 * Pure response interpreter, separated from the fetch call so it can be unit
 * tested without mocking the network. Mirrors exactly what
 * backend/api/routes/reports.ts's POST / returns for each case.
 */
export function interpretCreateReportResponse(status: number, body: Record<string, unknown>): CreateReportOutcome {
  if (status === 201) {
    return { outcome: 'CREATED', report: body.report as RankingReport };
  }
  if (status === 404) {
    return { outcome: 'RUN_NOT_FOUND' };
  }
  if (status === 409 && typeof body.existingReportId === 'string') {
    return { outcome: 'DUPLICATE', existingReportId: body.existingReportId };
  }
  if (status === 409) {
    return { outcome: 'RUN_NOT_COMPLETED', message: (body.error as string) ?? 'Run is not completed' };
  }
  return { outcome: 'ERROR', message: (body.error as string) ?? `Request failed with status ${status}` };
}

/** Step 1 of the report wizard: creates the report and eagerly computes analytics. No Claude call. */
export async function createReport(runId: string, previousRunId?: string, previousBaselineId?: string): Promise<CreateReportOutcome> {
  const res = await apiFetch('/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, previousRunId, previousBaselineId }),
  });
  const body = await res.json().catch(() => ({}));
  return interpretCreateReportResponse(res.status, body);
}

export async function getReports(clientId: string): Promise<RankingReportListItem[]> {
  const res = await apiFetch(`/reports?clientId=${encodeURIComponent(clientId)}`);
  return handle<RankingReportListItem[]>(res);
}

export async function getReport(reportId: string): Promise<RankingReport> {
  const res = await apiFetch(`/reports/${reportId}`);
  return handle<RankingReport>(res);
}

export interface DraftGenerationResult {
  outcome: 'SUCCESS' | 'VALIDATION_ERROR' | 'CALL_ERROR';
  errorMessage?: string;
}

export interface BuildReportResult {
  outcome: 'SUCCESS';
  clientPdfPath: string;
}

/**
 * "Build Report" wizard step: PENDING_ANALYSIS|ANALYSIS_READY -> REPORT_READY.
 * Deterministic, no Claude. Generates the client-facing PDF once and stores
 * it server-side -- fetch it via getReportPdfUrl, never regenerate it.
 */
export async function buildReport(reportId: string): Promise<BuildReportResult> {
  const res = await apiFetch(`/reports/${reportId}/build-report`, { method: 'POST' });
  return handle<BuildReportResult>(res);
}

/** URL for the stored PDF artifact -- the SAME file previewed and later attached to the email. */
export function getReportPdfUrl(reportId: string): string {
  return `${BASE}/reports/${reportId}/pdf`;
}

export async function generateEmailDraft(reportId: string): Promise<DraftGenerationResult> {
  const res = await apiFetch(`/reports/${reportId}/generate-email-draft`, { method: 'POST' });
  return handle<DraftGenerationResult>(res);
}

/**
 * "Regenerate report": rebuild the comparison, PDF (dated today) and email
 * draft from the run's current verified rows -- no file needed. Throws with
 * a plain-language message if the report is locked (sent / being sent).
 */
export async function regenerateReport(
  reportId: string,
  options: { confirmResend?: boolean } = {},
): Promise<
  | { outcome: 'DONE'; report: RankingReport; summary: ReportGenerationSummary }
  | { outcome: 'NEEDS_RESEND_CONFIRM'; resend: ResendInfo }
> {
  const res = await apiFetch(`/reports/${reportId}/regenerate-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmResend: options.confirmResend === true }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body.code === 'RESEND_CONFIRMATION_REQUIRED') {
    return { outcome: 'NEEDS_RESEND_CONFIRM', resend: { sendCount: body.sendCount ?? 1, lastSentAt: body.lastSentAt ?? null } };
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed with status ${res.status}`);
  return {
    outcome: 'DONE',
    report: body.report as RankingReport,
    summary: { regenerated: Boolean(body.regenerated), rowsChanged: body.rowsChanged ?? null, previousBaseline: body.previousBaseline ?? null },
  };
}

export async function regenerateEmailDraft(reportId: string): Promise<DraftGenerationResult> {
  const res = await apiFetch(`/reports/${reportId}/regenerate`, { method: 'POST' });
  return handle<DraftGenerationResult>(res);
}

export interface UpdateReportDraftInput {
  emailSubject?: string;
  emailBody?: string;
  emailBodyHtml?: string;
  resolvedRecipients?: string[];
  resolvedCc?: string[];
  resolvedClickupTaskUrl?: string | null;
  attachmentSource?: 'generated' | 'custom';
}

export async function updateReportDraft(reportId: string, edits: UpdateReportDraftInput): Promise<RankingReport> {
  const res = await apiFetch(`/reports/${reportId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edits),
  });
  return handle<RankingReport>(res);
}


export interface ApproveAndSendResult {
  outcome: 'SENT' | 'NO_RECIPIENTS' | 'ALREADY_PROCESSED' | 'SEND_FAILED';
  messageId?: string;
  errorMessage?: string;
}

// approvedBy is no longer a request param -- the backend derives it from the
// authenticated session (req.authUser.email) so it can't be spoofed by
// whatever a request body happens to send.
export async function approveAndSendReport(reportId: string): Promise<ApproveAndSendResult> {
  const res = await apiFetch(`/reports/${reportId}/approve-and-send`, {
    method: 'POST',
  });
  // Every outcome (SENT/NO_RECIPIENTS/ALREADY_PROCESSED/SEND_FAILED) is a
  // meaningful JSON body, not a generic failure -- read it directly instead
  // of the throw-on-!ok `handle` helper.
  return res.json();
}

export async function rejectReport(reportId: string): Promise<RankingReport> {
  const res = await apiFetch(`/reports/${reportId}/reject`, { method: 'POST' });
  return handle<RankingReport>(res);
}

// -- Notifications ----------------------------------------------------------

export async function getNotifications(workspaceId: string): Promise<NotificationsResponse> {
  const res = await apiFetch(`/notifications?workspaceId=${encodeURIComponent(workspaceId)}`);
  return handle<NotificationsResponse>(res);
}

export async function markNotificationsRead(workspaceId: string): Promise<void> {
  await apiFetch('/notifications/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
}

// -- Previous-ranking baselines ---------------------------------------------

/** Parses the file and returns the extraction preview -- writes nothing to the DB. */
export async function previewBaseline(clientId: string, file: File): Promise<BaselinePreview> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch(`/clients/${clientId}/baselines/preview`, { method: 'POST', body: formData });
  return handle<BaselinePreview>(res);
}

/** Persists exactly the (possibly user-reviewed) preview data -- never re-parses the file. */
export async function confirmBaseline(clientId: string, preview: BaselinePreview): Promise<BaselineRecord> {
  const res = await apiFetch(`/clients/${clientId}/baselines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceFilename: preview.sourceFilename,
      sourceType: preview.sourceType,
      baselineDate: preview.baselineDate,
      rows: preview.rows,
    }),
  });
  return handle<BaselineRecord>(res);
}

export async function getBaselines(clientId: string): Promise<BaselineRecord[]> {
  const res = await apiFetch(`/clients/${clientId}/baselines`);
  return handle<BaselineRecord[]>(res);
}

// -- Compare Reports (standalone tab -- nothing is saved) -------------------

export interface ComparedRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
  section: string | null;
}

export interface ComparedReport {
  fileName: string;
  date: string;
  dateLabel: string;
  keywordCount: number;
}

/** Result of comparing two uploaded report files -- sent back as-is to get the PDF. */
export interface ReportComparison {
  older: ComparedReport;
  newer: ComparedReport;
  clientName: string;
  clientDomain: string | null;
  sections: { name: string; domain: string }[];
  primarySearchDomain: string | null;
  currentRows: ComparedRow[];
  previousRows: ComparedRow[];
  summary: { matched: number; onlyInNewer: number; onlyInOlder: number; improved: number; declined: number; unchanged: number };
}

/** Upload two report files (Excel or PDF); older/newer is worked out from their dates. */
export async function compareReports(file1: File, file2: File): Promise<ReportComparison> {
  const formData = new FormData();
  formData.append('file1', file1);
  formData.append('file2', file2);
  const res = await apiFetch('/compare-reports/preview', { method: 'POST', body: formData });
  return handle<ReportComparison>(res);
}

/** Build the comparison PDF (same layout as the client reports). Returns the PDF and its download file name -- built here, since a cross-origin response hides Content-Disposition. */
export async function compareReportsPdf(comparison: ReportComparison, clientName: string, clientDomain: string): Promise<{ blob: Blob; fileName: string }> {
  const res = await apiFetch('/compare-reports/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName,
      clientDomain,
      olderDate: comparison.older.date,
      newerDate: comparison.newer.date,
      currentRows: comparison.currentRows,
      previousRows: comparison.previousRows,
      sections: comparison.sections,
      primarySearchDomain: comparison.primarySearchDomain,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  const safeName = clientName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Client';
  const fileName = `${safeName} - Keyword Ranking Report - ${comparison.older.dateLabel} - ${comparison.newer.dateLabel}.pdf`;
  return { blob: await res.blob(), fileName };
}
