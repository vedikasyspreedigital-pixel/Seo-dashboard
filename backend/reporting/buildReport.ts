import { ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { generateReportHtml } from "./reportGenerator.js";
import { markReportReady } from "./reportTransitions.js";
import { InvalidReportTransitionError } from "./errors.js";
import type { RunAnalytics } from "./computeRunAnalytics.js";
import type { AnalystOutput } from "./reportAnalyst.js";

// The "Build Report" wizard step: ANALYSIS_READY -> REPORT_READY. Purely
// deterministic (the Report Generator, not Claude) -- reads the analytics +
// analysis already stored on the report by generateInsights.ts and renders
// the HTML. Separated out so the UI can show Analyst Insights for review
// before committing to the rendered report.

export type BuildReportResult = { outcome: "SUCCESS"; reportHtml: string };

export async function buildReport(reportId: string): Promise<BuildReportResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { client: true, run: true, previousRun: true },
  });

  // Checked explicitly, before touching analysisJson: an out-of-order call
  // (e.g. still PENDING_ANALYSIS) has no analysisJson yet, and
  // generateReportHtml would throw a raw error reading it rather than the
  // clean InvalidReportTransitionError markReportReady's own guard gives on
  // the *correct* path (after this function has already done real work).
  if (report.status !== ReportStatus.ANALYSIS_READY) {
    throw new InvalidReportTransitionError(reportId, "build report (report must be ANALYSIS_READY)");
  }

  const period = {
    from: (report.previousRun?.createdAt ?? report.run.createdAt).toISOString(),
    to: report.run.createdAt.toISOString(),
  };

  const reportHtml = generateReportHtml({
    clientName: report.client.name,
    period,
    analytics: report.analyticsJson as unknown as RunAnalytics,
    analysis: report.analysisJson as unknown as AnalystOutput,
  });

  await markReportReady(reportId, { reportHtml });
  return { outcome: "SUCCESS", reportHtml };
}
