import type {
  ClientRecord,
  CreateRunResult,
  OverviewData,
  RankingReport,
  RankingReportListItem,
  RankingRun,
  RunProgress,
  RunRow,
  ValidateRunFileResult,
} from './types';

const BASE = '/api';

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getClients(): Promise<ClientRecord[]> {
  const res = await fetch(`${BASE}/clients`);
  return handle<ClientRecord[]>(res);
}

export async function getOverview(): Promise<OverviewData> {
  const res = await fetch(`${BASE}/overview`);
  return handle<OverviewData>(res);
}

export async function createRun(clientId: string, file: File): Promise<CreateRunResult> {
  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('file', file);
  const res = await fetch(`${BASE}/runs`, { method: 'POST', body: formData });
  return handle<CreateRunResult>(res);
}

/** Preview only -- parses the file server-side but creates nothing. */
export async function validateRunFile(clientId: string, file: File): Promise<ValidateRunFileResult> {
  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('file', file);
  const res = await fetch(`${BASE}/runs/validate`, { method: 'POST', body: formData });
  return handle<ValidateRunFileResult>(res);
}

export async function startRun(runId: string): Promise<RankingRun> {
  const res = await fetch(`${BASE}/runs/${runId}/start`, { method: 'POST' });
  return handle<RankingRun>(res);
}

export async function cancelRun(runId: string): Promise<RankingRun> {
  const res = await fetch(`${BASE}/runs/${runId}/cancel`, { method: 'POST' });
  return handle<RankingRun>(res);
}

export async function getRuns(clientId: string): Promise<RankingRun[]> {
  const res = await fetch(`${BASE}/runs?clientId=${encodeURIComponent(clientId)}`);
  return handle<RankingRun[]>(res);
}

export async function getRun(runId: string): Promise<RankingRun> {
  const res = await fetch(`${BASE}/runs/${runId}`);
  return handle<RankingRun>(res);
}

export async function getRunRows(runId: string): Promise<RunRow[]> {
  const res = await fetch(`${BASE}/runs/${runId}/rows`);
  return handle<RunRow[]>(res);
}

export async function getRunProgress(runId: string): Promise<RunProgress> {
  const res = await fetch(`${BASE}/runs/${runId}/progress`);
  return handle<RunProgress>(res);
}

export function getExportUrl(runId: string): string {
  return `${BASE}/runs/${runId}/export`;
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
export async function createReport(runId: string, previousRunId?: string): Promise<CreateReportOutcome> {
  const res = await fetch(`${BASE}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, previousRunId }),
  });
  const body = await res.json().catch(() => ({}));
  return interpretCreateReportResponse(res.status, body);
}

export async function getReports(clientId: string): Promise<RankingReportListItem[]> {
  const res = await fetch(`${BASE}/reports?clientId=${encodeURIComponent(clientId)}`);
  return handle<RankingReportListItem[]>(res);
}

export async function getReport(reportId: string): Promise<RankingReport> {
  const res = await fetch(`${BASE}/reports/${reportId}`);
  return handle<RankingReport>(res);
}

export interface DraftGenerationResult {
  outcome: 'SUCCESS' | 'VALIDATION_ERROR' | 'CALL_ERROR';
  errorMessage?: string;
}

/** Step 2 of the report wizard: PENDING_ANALYSIS -> ANALYSIS_READY, via the (mocked) Claude analyst. */
export async function generateInsights(reportId: string): Promise<DraftGenerationResult> {
  const res = await fetch(`${BASE}/reports/${reportId}/generate-insights`, { method: 'POST' });
  return handle<DraftGenerationResult>(res);
}

export interface BuildReportResult {
  outcome: 'SUCCESS';
  reportHtml: string;
}

/** Step 3 of the report wizard: ANALYSIS_READY -> REPORT_READY. Deterministic, no Claude. */
export async function buildReport(reportId: string): Promise<BuildReportResult> {
  const res = await fetch(`${BASE}/reports/${reportId}/build-report`, { method: 'POST' });
  return handle<BuildReportResult>(res);
}

export async function generateEmailDraft(reportId: string): Promise<DraftGenerationResult> {
  const res = await fetch(`${BASE}/reports/${reportId}/generate-email-draft`, { method: 'POST' });
  return handle<DraftGenerationResult>(res);
}

export async function regenerateEmailDraft(reportId: string): Promise<DraftGenerationResult> {
  const res = await fetch(`${BASE}/reports/${reportId}/regenerate`, { method: 'POST' });
  return handle<DraftGenerationResult>(res);
}

export interface UpdateReportDraftInput {
  emailSubject?: string;
  emailBody?: string;
  emailBodyHtml?: string;
  resolvedRecipients?: string[];
  resolvedClickupTaskUrl?: string | null;
}

export async function updateReportDraft(reportId: string, edits: UpdateReportDraftInput): Promise<RankingReport> {
  const res = await fetch(`${BASE}/reports/${reportId}`, {
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

export async function approveAndSendReport(reportId: string, approvedBy: string): Promise<ApproveAndSendResult> {
  const res = await fetch(`${BASE}/reports/${reportId}/approve-and-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedBy }),
  });
  // Every outcome (SENT/NO_RECIPIENTS/ALREADY_PROCESSED/SEND_FAILED) is a
  // meaningful JSON body, not a generic failure -- read it directly instead
  // of the throw-on-!ok `handle` helper.
  return res.json();
}

export async function rejectReport(reportId: string): Promise<RankingReport> {
  const res = await fetch(`${BASE}/reports/${reportId}/reject`, { method: 'POST' });
  return handle<RankingReport>(res);
}
