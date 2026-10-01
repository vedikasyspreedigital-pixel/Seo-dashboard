import { ReportStatus } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { generateClientReportPdf } from "./generateClientReportPdf.js";
import { markReportReady } from "./reportTransitions.js";
import { InvalidReportTransitionError } from "./errors.js";
import type { RunAnalytics } from "./computeRunAnalytics.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same configurable-persistent-disk pattern as UPLOADS_DIR in runs.ts.
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../reports");

export type BuildReportResult = { outcome: "SUCCESS"; clientPdfPath: string; reportDate: Date };

const BUILDABLE_STATUSES: ReportStatus[] = [ReportStatus.PENDING_ANALYSIS, ReportStatus.ANALYSIS_READY, ReportStatus.REPORT_READY];

/**
 * "Build Report": PENDING_ANALYSIS -> REPORT_READY (or ANALYSIS_READY ->
 * REPORT_READY, for reports that went through Insights first). Generates
 * the client-facing PDF -- Report Summary + one Keyword Table, straight from
 * the report's own deterministic analyticsJson, no Claude involved -- and
 * writes it to disk. That stored file is the single artifact: the PDF
 * Preview page and the email attachment both read this same file, never
 * regenerating it independently.
 *
 * Safe to call again on a report that's already REPORT_READY (e.g. the user
 * went Back to Analytics Preview and clicked Build Report a second time, or
 * a double-click/race fired two requests): this is treated as an idempotent
 * "regenerate in place" -- the PDF is rebuilt and clientPdfPath is
 * overwritten, but status stays REPORT_READY, not a walk backward through
 * the state machine. Reports that have moved further (EMAIL_DRAFTED and
 * beyond) still reject -- this never re-runs Claude/analytics/DataForSEO or
 * touches the email draft/approval state.
 */
/**
 * Each keyword's location for the PDF's per-location grouping, keyed by
 * rowUid, with locations in the order they first appear in the run's Excel
 * (sourceRowNumber). A location is Location + Google domain (domain compared
 * case-insensitively, so "Google.ae" and "google.ae" are one group).
 *
 * Keyed by BOTH the row's rowUid and its normalized keyword: analytics from a
 * prior-run comparison (computeRunAnalytics) label movements with the real
 * rowUid, but a baseline comparison (compareRunToBaseline -- the usual case)
 * labels them with normalizeKeyword(keyword) instead. Keying by rowUid alone
 * found no baseline-compared row, so every keyword fell into the first
 * location and a multi-location report came out as one flat table (Twin
 * Crown, 2026-10-01).
 */
export async function loadRowLocations(runId: string) {
  const rows = await prisma.rankingRow.findMany({
    where: { runId },
    select: { rowUid: true, keyword: true, locationName: true, seDomain: true },
    orderBy: { sourceRowNumber: "asc" },
  });
  const order: string[] = [];
  const byRowUid: Record<string, string> = {};
  const labels: Record<string, { locationName: string; seDomain: string }> = {};
  for (const row of rows) {
    const domain = row.seDomain.trim().toLowerCase();
    const key = row.locationName.trim() + "|" + domain;
    if (!labels[key]) {
      labels[key] = { locationName: row.locationName.trim(), seDomain: domain };
      order.push(key);
    }
    byRowUid[row.rowUid] = key;
    byRowUid[normalizeKeyword(row.keyword)] = key;
  }
  return { order, byRowUid, labels };
}

export async function buildReport(reportId: string): Promise<BuildReportResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { client: true, run: true, previousRun: true, previousBaseline: true },
  });

  if (!BUILDABLE_STATUSES.includes(report.status)) {
    throw new InvalidReportTransitionError(reportId, "build report (report must be PENDING_ANALYSIS, ANALYSIS_READY, or REPORT_READY)");
  }
  if (!report.analyticsJson) {
    throw new Error(`Report ${reportId} has no analyticsJson yet -- cannot build the client PDF.`);
  }

  const analytics = report.analyticsJson as unknown as RunAnalytics;
  // Stored on the report (markReportReady below) so the email's period end
  // and the run's own baseline date use exactly this same day.
  const reportDate = new Date();
  const domainRows = await prisma.rankingRow.findMany({
    where: { runId: report.runId },
    select: { seDomain: true },
    distinct: ["seDomain"],
  });
  const locations = await loadRowLocations(report.runId);
  const pdfBuffer = await generateClientReportPdf({
    clientName: report.client.name,
    clientDomain: report.client.domain,
    searchEngineDomains: domainRows.map((r) => r.seDomain),
    locations,
    // The date shown under the title (and as the "current" column header in
    // the ranking table) is the day this PDF is actually being built, not
    // when the underlying run finished fetching -- the two can differ by
    // several days between fetching, manual verification, and sending.
    currentRunDate: reportDate,
    // A report's "previous" side is either a prior real run OR an imported
    // baseline, never both (see createReportForRun) -- whichever is set
    // supplies the comparison date shown in the PDF header.
    previousRunDate: report.previousRun
      ? (report.previousRun.completedAt ?? report.previousRun.createdAt)
      : report.previousBaseline
        ? report.previousBaseline.baselineDate
        : null,
    analytics,
  });

  await mkdir(REPORTS_DIR, { recursive: true });
  const clientPdfPath = path.join(REPORTS_DIR, `${reportId}.pdf`);
  await writeFile(clientPdfPath, pdfBuffer);

  await markReportReady(reportId, { clientPdfPath, reportDate });
  return { outcome: "SUCCESS", clientPdfPath, reportDate };
}
