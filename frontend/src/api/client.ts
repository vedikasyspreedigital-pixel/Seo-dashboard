import type {
  ClientRecord,
  CreateClientInput,
  CreateRunResult,
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

export async function getOverview(workspaceId: string): Promise<OverviewData> {
  const res = await apiFetch(`/overview?workspaceId=${encodeURIComponent(workspaceId)}`);
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
  const res = await apiFetch('/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, previousRunId }),
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

export async function regenerateEmailDraft(reportId: string): Promise<DraftGenerationResult> {
  const res = await apiFetch(`/reports/${reportId}/regenerate`, { method: 'POST' });
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

export async function approveAndSendReport(reportId: string, approvedBy: string): Promise<ApproveAndSendResult> {
  const res = await apiFetch(`/reports/${reportId}/approve-and-send`, {
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
  const res = await apiFetch(`/reports/${reportId}/reject`, { method: 'POST' });
  return handle<RankingReport>(res);
}
