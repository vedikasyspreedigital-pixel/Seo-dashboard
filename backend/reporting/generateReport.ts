import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeRunAnalytics } from "./computeRunAnalytics.js";
import { buildAnalystInput, runReportAnalyst, type CallClaudeFn } from "./reportAnalyst.js";
import { generateReportHtml } from "./reportGenerator.js";
import { markAnalysisReady, markAnalysisFailed, markReportReady } from "./reportTransitions.js";

// The report generation service: ties together computeRunAnalytics (pure
// code), ClientReportConfig, the Claude Report Analyst (via an injected
// client -- real or mock, never decided here), the deterministic HTML
// generator, and the ranking_reports state machine. Nothing here touches
// ranking_runs/ranking_rows, and nothing here sends email -- that's a later,
// separate step.

export type GenerateAnalysisAndReportResult =
  | { outcome: "SUCCESS"; analytics: unknown; analysis: unknown; reportHtml: string }
  | { outcome: "VALIDATION_ERROR"; errorMessage: string }
  | { outcome: "CALL_ERROR"; errorMessage: string };

export async function generateAnalysisAndReport(
  reportId: string,
  callClaude: CallClaudeFn,
): Promise<GenerateAnalysisAndReportResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { run: true, client: true },
  });

  const previousRun = report.previousRunId
    ? await prisma.rankingRun.findUnique({ where: { id: report.previousRunId } })
    : null;

  const analytics = await computeRunAnalytics(report.runId, report.previousRunId ?? undefined);

  const config = await prisma.clientReportConfig.findFirst({
    where: { clientId: report.clientId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  const period = {
    from: (previousRun?.createdAt ?? report.run.createdAt).toISOString(),
    to: report.run.createdAt.toISOString(),
  };

  const analystInput = buildAnalystInput({
    clientName: report.client.name,
    analytics,
    config: config
      ? { reportTone: config.reportTone, sectionsEnabled: config.sectionsEnabled, customInstructions: config.customInstructions }
      : null,
    period,
  });

  const result = await runReportAnalyst(analystInput, callClaude);

  if (result.outcome !== "SUCCESS") {
    const errorMessage = result.outcome === "CALL_ERROR" ? result.errorMessage : result.errors.join("; ");
    await markAnalysisFailed(reportId, { errorMessage });
    return { outcome: result.outcome, errorMessage };
  }

  await markAnalysisReady(reportId, {
    analyticsJson: analytics as unknown as Prisma.InputJsonValue,
    analysisJson: result.data as unknown as Prisma.InputJsonValue,
  });

  const reportHtml = generateReportHtml({ clientName: report.client.name, period, analytics, analysis: result.data });
  await markReportReady(reportId, { reportHtml });

  return { outcome: "SUCCESS", analytics, analysis: result.data, reportHtml };
}
