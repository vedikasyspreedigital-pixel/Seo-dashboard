import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KeywordExportError, SOURCE_LABELS, readKeywordExport, type KeywordSource } from "./readKeywordExport.js";
import { domainReportDir } from "./createDomainReport.js";
import { FetchError, bareDomain, runExclusive, type FetchExportFn } from "./fetchers/flikoverAhrefs.js";

// Domain Intelligence Phase 2, the user's flow (2026-10-19): "Fetch from
// Ahrefs" runs in the background while the user uploads the Semrush and
// Ubersuggest exports; when it's done the fetched file shows as attached in
// the Ahrefs slot, and "Combine and post" (the Phase 1 POST /reports) uses it
// like an upload. Nothing is combined or posted until the user clicks.
//
// Jobs live in memory (a restart forgets them -- just fetch again) and their
// files on disk for a day. One fetch at a time app-wide (runExclusive).

export type FetchJobState = "queued" | "fetching" | "done" | "failed";

export interface FetchJob {
  id: string;
  source: KeywordSource;
  clientId: string;
  workspaceId: string | null;
  websiteUrl: string;
  location: string | null;
  state: FetchJobState;
  step?: string;
  keywords?: number;
  fileName?: string;
  error?: string;
  code?: string;
  createdAt: string;
  updatedAt: string;
  /** Server path -- never sent to the browser (publicJob). */
  filePath?: string;
}

const KEEP_MS = 24 * 60 * 60 * 1000;
const jobs = new Map<string, FetchJob>();
const fetchDir = () => path.join(domainReportDir("fetches"));
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);

function update(job: FetchJob, patch: Partial<FetchJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

/** Drops jobs older than a day, with their files. */
async function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const job of jobs.values()) {
    if (Date.parse(job.updatedAt) >= cutoff || job.state === "queued" || job.state === "fetching") continue;
    jobs.delete(job.id);
    if (job.filePath) await rm(job.filePath, { force: true }).catch(() => {});
  }
}

export class FetchJobError extends Error {}

/** Starts a background fetch; returns at once with the queued job. */
export async function startFetch(
  input: { source: KeywordSource; client: { id: string; workspaceId: string | null }; websiteUrl: string; location: string | null },
  fetchers: Partial<Record<KeywordSource, FetchExportFn>>,
): Promise<FetchJob> {
  const fetcher = fetchers[input.source];
  if (!fetcher) throw new FetchJobError(`${SOURCE_LABELS[input.source]} can't be fetched automatically -- upload its export instead.`);
  // Same client, tool AND website: a competitor's Semrush fetch runs alongside the client's own.
  const running = [...jobs.values()].find(
    (j) =>
      j.clientId === input.client.id &&
      j.source === input.source &&
      bareDomain(j.websiteUrl) === bareDomain(input.websiteUrl) &&
      (j.state === "queued" || j.state === "fetching"),
  );
  if (running) return running; // a double-click never starts a second robot
  await prune();
  const now = new Date().toISOString();
  const job: FetchJob = {
    id: randomUUID(),
    source: input.source,
    clientId: input.client.id,
    workspaceId: input.client.workspaceId,
    websiteUrl: input.websiteUrl,
    location: input.location,
    state: "queued",
    step: "Waiting for the robot",
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  void run(job, fetcher);
  return job;
}

async function run(job: FetchJob, fetcher: FetchExportFn) {
  try {
    const fetched = await runExclusive(() => {
      update(job, { state: "fetching", step: "Starting" });
      return fetcher({ domain: bareDomain(job.websiteUrl), location: job.location, onStep: (step) => update(job, { step }) });
    });
    const parsed = await readKeywordExport(job.source, fetched.buffer, fetched.fileName);
    await mkdir(fetchDir(), { recursive: true });
    const filePath = path.join(fetchDir(), `${job.id}-${safeName(fetched.fileName)}`);
    await writeFile(filePath, fetched.buffer);
    update(job, { state: "done", step: undefined, keywords: parsed.rows.length, fileName: fetched.fileName, filePath });
  } catch (err) {
    const code = err instanceof FetchError ? err.code : err instanceof KeywordExportError ? "BAD_EXPORT" : "FAILED";
    if (!(err instanceof FetchError) && !(err instanceof KeywordExportError)) console.error(`[domainIntel] ${job.source} fetch ${job.id} failed:`, err);
    update(job, { state: "failed", step: undefined, code, error: (err as Error).message.slice(0, 500) });
  }
}

export function getJob(id: string): FetchJob | undefined {
  return jobs.get(id);
}

/** The fetched file of a finished job, for "Combine and post" -- only for the same client and tool. */
export async function fetchedExport(jobId: string, clientId: string, source: KeywordSource): Promise<{ buffer: Buffer; name: string }> {
  const job = jobs.get(jobId);
  if (!job || job.clientId !== clientId || job.source !== source) {
    throw new KeywordExportError(`The fetched ${SOURCE_LABELS[source]} file is no longer available -- fetch it again or upload it.`);
  }
  if (job.state === "failed") throw new KeywordExportError(`The ${SOURCE_LABELS[source]} fetch failed -- fetch it again or upload the file instead.`);
  if (job.state !== "done" || !job.filePath) throw new KeywordExportError(`${SOURCE_LABELS[source]} is still being fetched -- wait for it to finish.`);
  return { buffer: await readFile(job.filePath), name: job.fileName ?? `${source}.csv` };
}

/** A finished Semrush fetch of a COMPETITOR's site (same client), for the competitor sheet. */
export async function fetchedCompetitorExport(jobId: string, clientId: string): Promise<{ domain: string; buffer: Buffer; name: string }> {
  const job = jobs.get(jobId);
  if (!job || job.clientId !== clientId || job.source !== "semrush") throw new KeywordExportError("A competitor's Semrush file is no longer available -- fetch the competitors again.");
  return { domain: bareDomain(job.websiteUrl), ...(await fetchedExport(jobId, clientId, "semrush")) };
}

/** Codes meaning "a person must sign in to Flikover again". */
const LOGIN_PROBLEMS = ["SESSION_EXPIRED", "MULTIPLE_SESSIONS", "BOT_CHECK", "NO_SESSION"];

/** The newest Ahrefs fetch in these workspaces failed because the login died? -> the page's banner. */
export function latestLoginProblem(workspaceIds: string[]): { code: string; error: string; at: string } | null {
  const latest = [...jobs.values()]
    .filter((j) => j.source === "ahrefs" && j.workspaceId && workspaceIds.includes(j.workspaceId) && (j.state === "done" || j.state === "failed"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest?.state === "failed" && latest.code && LOGIN_PROBLEMS.includes(latest.code) ? { code: latest.code, error: latest.error ?? "", at: latest.updatedAt } : null;
}

/** For the browser: everything but the server path. */
export function publicJob(job: FetchJob) {
  const { filePath: _filePath, workspaceId: _ws, ...rest } = job;
  return rest;
}

/** Tests only. */
export function clearFetchJobs() {
  jobs.clear();
}
