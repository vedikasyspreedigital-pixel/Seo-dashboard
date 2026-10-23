import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { domainReportDir } from "./createDomainReport.js";
import { FetchError, bareDomain, type FetchExportFn } from "./fetchers/flikoverAhrefs.js";
import type { AiAuditWriter } from "./aiSeoAudit.js";

// Domain Intelligence report PDFs made by the office Chrome agent (user's plan,
// 2026-10-22): "siteaudit" = Semrush Site Audit through seotooladda (create or
// reuse the project, 1,000 pages, run once, wait for the crawl, download the
// PDF); "woorank" later. Unlike keyword fetches these can take many minutes
// (the crawl), so they do NOT go through runExclusive -- the agent itself
// still does one job at a time. Jobs live in memory, finished ones also on disk
// (PDF + details) for a week.

// "aiaudit" is made here, not by the agent: Gemini reads the client's latest
// finished agent reports (see aiSeoAudit.ts).
export type AuditKind = "siteaudit" | "woorank" | "aiaudit";
export const AUDIT_KINDS: AuditKind[] = ["siteaudit", "woorank", "aiaudit"];
export const AUDIT_LABELS: Record<AuditKind, string> = { siteaudit: "Semrush Site Audit", woorank: "WooRank Audit", aiaudit: "AI SEO Audit" };
/** The reports the AI SEO Audit reads, in order -- WooRank is its main source (the team's format). */
const AI_SOURCE_KINDS: AuditKind[] = ["woorank", "siteaudit"];

export interface AuditJob {
  id: string;
  kind: AuditKind;
  clientId: string;
  workspaceId: string | null;
  websiteUrl: string;
  state: "queued" | "running" | "done" | "failed";
  step?: string;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
  code?: string;
  createdAt: string;
  updatedAt: string;
  /** Server path -- never sent to the browser. */
  filePath?: string;
}

// A week: the AI SEO Audit reads the latest Site Audit / WooRank, and a Site Audit's crawl takes many minutes.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const jobs = new Map<string, AuditJob>();
const auditDir = () => domainReportDir("audits");
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);

function update(job: AuditJob, patch: Partial<AuditJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

async function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const job of jobs.values()) {
    if (job.state === "queued" || job.state === "running" || Date.parse(job.updatedAt) >= cutoff) continue;
    jobs.delete(job.id);
    if (job.filePath) await rm(job.filePath, { force: true }).catch(() => {});
    await rm(metaPath(job.id), { force: true }).catch(() => {});
  }
}

// A finished job's details are saved next to its PDF, so a restart (or a deploy)
// doesn't forget a Site Audit that took many minutes -- the AI SEO Audit reads it later.
const metaPath = (id: string) => path.join(auditDir(), `${id}.json`);

/** Called once at server start: brings back finished jobs from the last week. */
export async function loadSavedAudits() {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const job = JSON.parse(await readFile(path.join(auditDir(), name), "utf8")) as AuditJob;
      if (job.state !== "done" || !job.filePath || jobs.has(job.id)) continue;
      await stat(job.filePath);
      jobs.set(job.id, job);
    } catch {
      // unreadable or its PDF is gone -- skip
    }
  }
  await prune();
}

export class AuditJobError extends Error {}

/** The client's newest finished report of each kind the AI audit reads. */
function latestSources(clientId: string): AuditJob[] {
  return AI_SOURCE_KINDS.flatMap((kind) => {
    const done = [...jobs.values()].filter((j) => j.clientId === clientId && j.kind === kind && j.state === "done" && j.filePath);
    done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return done.slice(0, 1);
  });
}

export async function startAudit(
  input: { kind: AuditKind; client: { id: string; workspaceId: string | null; name?: string }; websiteUrl: string },
  fetchers: Partial<Record<AuditKind, FetchExportFn>>,
  aiWriter?: AiAuditWriter | null,
): Promise<AuditJob> {
  const fetcher = fetchers[input.kind];
  if (input.kind === "aiaudit") {
    if (!aiWriter) throw new AuditJobError("The AI SEO Audit needs Gemini (GEMINI_API_KEY isn't set on this server).");
    if (latestSources(input.client.id).length === 0) throw new AuditJobError("Run the WooRank audit (and the Semrush Site Audit) first -- the AI SEO Audit is built from them.");
  } else if (!fetcher) throw new AuditJobError(`${AUDIT_LABELS[input.kind]} isn't available on this server (it needs the office Chrome agent).`);
  const running = [...jobs.values()].find((j) => j.clientId === input.client.id && j.kind === input.kind && (j.state === "queued" || j.state === "running"));
  if (running) return running; // a double-click never queues a second audit
  await prune();
  const now = new Date().toISOString();
  const job: AuditJob = {
    id: randomUUID(),
    kind: input.kind,
    clientId: input.client.id,
    workspaceId: input.client.workspaceId,
    websiteUrl: input.websiteUrl,
    state: "queued",
    step: input.kind === "aiaudit" ? "Collecting the reports" : "Waiting for the office Chrome agent",
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  const make: () => Promise<{ buffer: Buffer; fileName: string }> =
    input.kind === "aiaudit"
      ? async () =>
          aiWriter!({
            clientName: input.client.name ?? bareDomain(input.websiteUrl),
            websiteUrl: input.websiteUrl,
            sources: await Promise.all(
              latestSources(input.client.id).map(async (s) => ({ label: AUDIT_LABELS[s.kind], fileName: s.fileName ?? `${s.kind}.pdf`, buffer: await readFile(s.filePath!) })),
            ),
            onStep: (step) => update(job, { state: "running", step }),
          })
      : () =>
          fetcher!({
            domain: bareDomain(job.websiteUrl),
            location: null,
            onStep: (step) => update(job, { state: "running", step }),
          });
  void run(job, make);
  return job;
}

async function run(job: AuditJob, make: () => Promise<{ buffer: Buffer; fileName: string }>) {
  try {
    const result = await make();
    // The agent's reports are PDFs; the AI SEO Audit is an Excel workbook (.xlsx = a zip, "PK").
    const xlsx = result.fileName.toLowerCase().endsWith(".xlsx");
    if (result.buffer.subarray(0, xlsx ? 2 : 4).toString("latin1") !== (xlsx ? "PK" : "%PDF")) {
      throw new FetchError("FAILED", xlsx ? "The AI SEO Audit file isn't a valid Excel workbook." : "The agent sent a file that isn't a PDF.");
    }
    await mkdir(auditDir(), { recursive: true });
    const filePath = path.join(auditDir(), `${job.id}-${safeName(result.fileName)}`);
    await writeFile(filePath, result.buffer);
    update(job, { state: "done", step: undefined, fileName: result.fileName, sizeBytes: result.buffer.length, filePath });
    await writeFile(metaPath(job.id), JSON.stringify(job)).catch(() => {});
  } catch (err) {
    const code = err instanceof FetchError ? err.code : "FAILED";
    if (!(err instanceof FetchError)) console.error(`[domainIntel] ${job.kind} ${job.id} failed:`, err);
    update(job, { state: "failed", step: undefined, code, error: (err as Error).message.slice(0, 500) });
  }
}

export function getAudit(id: string): AuditJob | undefined {
  return jobs.get(id);
}

export async function auditFile(id: string): Promise<{ buffer: Buffer; name: string } | null> {
  const job = jobs.get(id);
  if (!job || job.state !== "done" || !job.filePath) return null;
  return { buffer: await readFile(job.filePath), name: job.fileName ?? `${job.kind}.pdf` };
}

export function publicAudit(job: AuditJob) {
  const { filePath: _filePath, workspaceId: _ws, ...rest } = job;
  return rest;
}

/** Tests only. */
export function clearAuditJobs() {
  jobs.clear();
}
