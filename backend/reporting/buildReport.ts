import { ReportStatus } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { generateClientReportPdf } from "./generateClientReportPdf.js";
import { markReportReady } from "./reportTransitions.js";
import { InvalidReportTransitionError } from "./errors.js";
import type { RunAnalytics } from "./computeRunAnalytics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same configurable-persistent-disk pattern as UPLOADS_DIR in runs.ts.
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../reports");

export type BuildReportResult = { outcome: "SUCCESS"; clientPdfPath: string };

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
  const pdfBuffer = await generateClientReportPdf({
    clientName: report.client.name,
    currentRunDate: report.run.completedAt ?? report.run.createdAt,
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

  await markReportReady(reportId, { clientPdfPath });
  return { outcome: "SUCCESS", clientPdfPath };
}
