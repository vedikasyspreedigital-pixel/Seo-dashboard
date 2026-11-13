import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db/client.js";
import { COLUMN_HEADERS, STATUS_TEXT } from "../excel/mapping.js";
import { ingestExcelRun } from "../runs/ingestExcelRun.js";
import { startRun } from "../statemachine/runTransitions.js";
import { startRunProcessing } from "../dataforseo/engine.js";
import type { CallDataForSeoFn } from "../worker/processRun.js";
import { findOrCreateProspectClient } from "../domainIntel/prospectClient.js";
import { normalizeMatchDomain } from "../dataforseo/buildRequest.js";
import { buildBaselineForRun, saveKeywordMetrics, type BaselineBuild } from "./baselineReport.js";
import { fetchGoogleAdsMetrics, googleAdsConfigured, GoogleAdsError } from "./keywordPlanner.js";

/**
 * "Baseline Report" tab on Domain Intelligence (2026-11-13). The team types a new client's name, website, country
 * and keyword list ONCE; the dashboard checks the keywords as an ordinary run (Serper / DataForSEO -- whatever the
 * server is set to), fetches the volumes from Google Ads when the run is done, and hands back the Baseline Excel.
 * Download only: no report, no email, nothing goes to the client.
 */

/** The countries the tab offers -- the same codes as the Domain Intelligence location list. */
export const BASELINE_COUNTRIES: Record<string, { label: string; seDomain: string; locationName: string; adsCountry: string }> = {
  au: { label: "Australia", seDomain: "google.com.au", locationName: "Australia", adsCountry: "AU" },
  in: { label: "India", seDomain: "google.co.in", locationName: "India", adsCountry: "IN" },
  ae: { label: "United Arab Emirates", seDomain: "google.ae", locationName: "United Arab Emirates", adsCountry: "AE" },
  us: { label: "United States", seDomain: "google.com", locationName: "United States", adsCountry: "US" },
  uk: { label: "United Kingdom", seDomain: "google.co.uk", locationName: "United Kingdom", adsCountry: "GB" },
  ca: { label: "Canada", seDomain: "google.ca", locationName: "Canada", adsCountry: "CA" },
  nz: { label: "New Zealand", seDomain: "google.co.nz", locationName: "New Zealand", adsCountry: "NZ" },
  sa: { label: "Saudi Arabia", seDomain: "google.com.sa", locationName: "Saudi Arabia", adsCountry: "SA" },
  qa: { label: "Qatar", seDomain: "google.com.qa", locationName: "Qatar", adsCountry: "QA" },
  sg: { label: "Singapore", seDomain: "google.com.sg", locationName: "Singapore", adsCountry: "SG" },
};

export const MAX_BASELINE_KEYWORDS = 300;

export class BaselineJobInputError extends Error {}

/** One keyword per line (commas and tabs also split); trimmed, blank and repeated keywords dropped. */
export function parseKeywordText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\r\n\t,]+/)) {
    const k = raw.trim().replace(/\s+/g, " ");
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

/** The keywords of an uploaded Excel: the "Keywords"/"Keyword" column, else the first column. Header row skipped. */
export async function keywordsFromWorkbook(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BaselineJobInputError("That file isn't an Excel (.xlsx) file -- or paste the keywords instead.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new BaselineJobInputError("The Excel file has no sheet.");
  const text = (v: ExcelJS.CellValue) =>
    v == null ? "" : typeof v === "object" ? String((v as { text?: unknown; result?: unknown }).text ?? (v as { result?: unknown }).result ?? "") : String(v);
  let col = 1;
  let headerRow = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 5) && !headerRow; r++) {
    ws.getRow(r).eachCell((cell, c) => {
      if (!headerRow && /^keywords?$/i.test(text(cell.value).trim())) {
        col = c;
        headerRow = r;
      }
    });
  }
  const lines: string[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) lines.push(text(ws.getRow(r).getCell(col).value));
  return parseKeywordText(lines.join("\n"));
}

/** The keyword list as the run template the parser reads (Keywords | Full URL | URL | ... | Status = Pending). */
export async function keywordTemplateBuffer(keywords: string[], domain: string, country: { seDomain: string; locationName: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow([
    COLUMN_HEADERS.keyword,
    COLUMN_HEADERS.fullUrl,
    COLUMN_HEADERS.targetUrl,
    COLUMN_HEADERS.concatenate,
    COLUMN_HEADERS.locationName,
    COLUMN_HEADERS.seDomain,
    COLUMN_HEADERS.languageName,
    COLUMN_HEADERS.status,
    COLUMN_HEADERS.rank,
    COLUMN_HEADERS.rankingUrl,
  ]);
  const brand = domain.split(".")[0];
  for (const k of keywords) {
    ws.addRow([k, domain, `*${brand}.*`, `${k} ${domain}`, country.locationName, country.seDomain, "English", STATUS_TEXT.PENDING, null, null]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface CreateBaselineJobInput {
  workspaceId: string;
  clientName: string;
  websiteUrl: string;
  country: string;
  keywords: string[];
  createdBy: string | null;
  uploadsDir: string;
  callDataForSeo: CallDataForSeoFn;
}

/** Makes the client (a Domain Intelligence prospect), the run and the job, and starts checking the keywords. */
export async function createBaselineJob(input: CreateBaselineJobInput) {
  const country = BASELINE_COUNTRIES[input.country];
  if (!country) throw new BaselineJobInputError("Pick the client's country.");
  const domain = normalizeMatchDomain(input.websiteUrl.trim());
  if (!domain || !domain.includes(".")) throw new BaselineJobInputError("Enter the client's website, e.g. veneziadesigns.com.");
  if (input.keywords.length === 0) throw new BaselineJobInputError("Add at least one keyword.");
  if (input.keywords.length > MAX_BASELINE_KEYWORDS) {
    throw new BaselineJobInputError(`That's ${input.keywords.length} keywords -- at most ${MAX_BASELINE_KEYWORDS} per Baseline Report.`);
  }

  let client;
  try {
    // The same Domain Intelligence client keeps its ClickUp task (find-or-create sets the task it's given).
    const existing = await prisma.client.findFirst({
      where: { workspaceId: input.workspaceId, kind: "domain", archivedAt: null, name: { equals: input.clientName.trim().replace(/\s+/g, " "), mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { domainReportTaskId: true },
    });
    client = await findOrCreateProspectClient({
      workspaceId: input.workspaceId,
      name: input.clientName,
      websiteUrl: domain,
      clickupTask: existing?.domainReportTaskId ?? "",
    });
  } catch (err) {
    throw new BaselineJobInputError((err as Error).message);
  }

  const sourceFilename = `${client.name} - Baseline keywords.xlsx`;
  const buffer = await keywordTemplateBuffer(input.keywords, domain, country);
  const { run } = await ingestExcelRun({
    clientId: client.id,
    sourceFilename,
    sourceFilePath: path.join(input.uploadsDir, "not-saved-yet.xlsx"),
    fileBuffer: buffer,
    createdBy: input.createdBy ?? undefined,
  });
  await mkdir(input.uploadsDir, { recursive: true });
  const storedPath = path.join(input.uploadsDir, `${run.id}.xlsx`);
  await writeFile(storedPath, buffer);
  await prisma.rankingRun.update({ where: { id: run.id }, data: { sourceFilePath: storedPath } });

  const job = await prisma.baselineJob.create({
    data: { workspaceId: input.workspaceId, clientId: client.id, runId: run.id, country: country.adsCountry, createdBy: input.createdBy },
  });
  await startRun(run.id);
  await startRunProcessing(run.id, input.callDataForSeo, " (baseline)");
  return job;
}

export type BaselineJobState = "checking" | "volumes" | "ready" | "failed";

export interface BaselineJobView {
  id: string;
  clientName: string;
  domain: string | null;
  country: string;
  createdAt: string;
  createdBy: string | null;
  state: BaselineJobState;
  total: number;
  done: number;
  ranked: number;
  failed: number;
  volumes: "fetched" | "fetching" | "failed" | "not_set_up" | "waiting";
  volumesError: string | null;
  runId: string;
}

const volumeFetches = new Map<string, Promise<void>>();

/** Every keyword has an answer (some may have failed -- "Not in 100" / blank in the Excel). */
const runFinished = (status: string) => status === "COMPLETED" || status === "COMPLETED_WITH_ERRORS";

/**
 * Google Ads volumes for a finished job's keywords -- once. A failure is saved on the job (shown on its card) and
 * the Excel still downloads, with "0 – 10 / Unknown" for those keywords.
 */
export function ensureVolumes(jobId: string): Promise<void> {
  const running = volumeFetches.get(jobId);
  if (running) return running;
  const p = (async () => {
    const job = await prisma.baselineJob.findUnique({ where: { id: jobId }, include: { run: { select: { status: true } } } });
    if (!job || job.volumesFetchedAt || job.volumesError || !runFinished(job.run.status) || !googleAdsConfigured()) return;
    const rows = await prisma.rankingRow.findMany({ where: { runId: job.runId }, select: { keyword: true } });
    try {
      const metrics = await fetchGoogleAdsMetrics(
        rows.map((r) => r.keyword),
        job.country,
      );
      await saveKeywordMetrics(job.clientId, metrics, "google_ads", job.createdBy);
      await prisma.baselineJob.update({ where: { id: jobId }, data: { volumesFetchedAt: new Date(), volumesError: null } });
    } catch (err) {
      const message = err instanceof GoogleAdsError ? err.message : `Google Ads didn't answer: ${(err as Error).message}`;
      await prisma.baselineJob.update({ where: { id: jobId }, data: { volumesError: message.slice(0, 500) } });
    }
  })().finally(() => volumeFetches.delete(jobId));
  volumeFetches.set(jobId, p);
  return p;
}

/** Fetch the volumes again (after a failure). */
export async function retryVolumes(jobId: string): Promise<void> {
  await prisma.baselineJob.update({ where: { id: jobId }, data: { volumesError: null, volumesFetchedAt: null } });
  await ensureVolumes(jobId);
}

export async function viewBaselineJobs(where: { workspaceId: string; id?: string }, take = 30): Promise<BaselineJobView[]> {
  const jobs = await prisma.baselineJob.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    include: { client: { select: { name: true, domain: true } }, run: { select: { status: true, totalRows: true } } },
  });
  if (jobs.length === 0) return [];
  const counts = await prisma.rankingRow.groupBy({
    by: ["runId", "status"],
    where: { runId: { in: jobs.map((j) => j.runId) } },
    _count: true,
  });
  const ranked = await prisma.rankingRow.groupBy({
    by: ["runId"],
    where: { runId: { in: jobs.map((j) => j.runId) }, rankValue: { not: null } },
    _count: true,
  });
  const views: BaselineJobView[] = [];
  for (const j of jobs) {
    const of = (s: string) => counts.find((c) => c.runId === j.runId && c.status === s)?._count ?? 0;
    const done = of("COMPLETED") + of("FAILED");
    const runDone = runFinished(j.run.status);
    // A finished run gets its volumes in the background; the card shows "Getting volumes" meanwhile.
    if (runDone && !j.volumesFetchedAt && !j.volumesError && googleAdsConfigured()) void ensureVolumes(j.id);
    const volumes: BaselineJobView["volumes"] = j.volumesFetchedAt
      ? "fetched"
      : j.volumesError
        ? "failed"
        : !googleAdsConfigured()
          ? "not_set_up"
          : runDone
            ? "fetching"
            : "waiting";
    const state: BaselineJobState =
      j.run.status === "CANCELLED" ? "failed" : !runDone ? "checking" : volumes === "fetching" ? "volumes" : "ready";
    views.push({
      id: j.id,
      clientName: j.client.name,
      domain: j.client.domain,
      country: j.country,
      createdAt: j.createdAt.toISOString(),
      createdBy: j.createdBy,
      state,
      total: j.run.totalRows,
      done,
      ranked: ranked.find((r) => r.runId === j.runId)?._count ?? 0,
      failed: of("FAILED"),
      volumes,
      volumesError: j.volumesError,
      runId: j.runId,
    });
  }
  return views;
}

export async function buildBaselineForJob(jobId: string): Promise<BaselineBuild> {
  const job = await prisma.baselineJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { client: { select: { id: true, name: true, domain: true } }, run: { select: { completedAt: true, createdAt: true } } },
  });
  return buildBaselineForRun({ runId: job.runId, client: job.client, reportDate: job.run.completedAt ?? job.run.createdAt });
}
