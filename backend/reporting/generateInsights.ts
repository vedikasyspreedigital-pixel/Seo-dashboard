import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeRunAnalytics } from "./computeRunAnalytics.js";
import { buildAnalystInput, runReportAnalyst, type CallClaudeFn } from "./reportAnalyst.js";
import { markAnalysisReady, markAnalysisFailed } from "./reportTransitions.js";

// The "Generate Insights with Claude" wizard step: PENDING_ANALYSIS ->
// ANALYSIS_READY only -- deliberately stops short of building the HTML
// report (see buildReport.ts for that separate, deterministic step). This
// lets the UI show the Claude analyst's narrative for review before
// committing to a rendered report, matching the reference design's explicit
// "the Claude call happens only when you generate insights" checkpoint.
//
// Reuses the exact same building blocks as generateAnalysisAndReport.ts
// (computeRunAnalytics, buildAnalystInput, runReportAnalyst,
// markAnalysisReady/markAnalysisFailed) rather than modifying that already
// tested, unchanged, one-shot pipeline -- generateAnalysisAndReport.ts is
// left untouched.

export type GenerateInsightsResult =
  | { outcome: "SUCCESS"; analytics: unknown; analysis: unknown }
  | { outcome: "VALIDATION_ERROR"; errorMessage: string }
  | { outcome: "CALL_ERROR"; errorMessage: string };

export async function generateInsights(reportId: string, callClaude: CallClaudeFn): Promise<GenerateInsightsResult> {
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
    return { outcome: result.outcome, errorMessage } as GenerateInsightsResult;
  }

  await markAnalysisReady(reportId, {
    analyticsJson: analytics as unknown as Prisma.InputJsonValue,
    analysisJson: result.data as unknown as Prisma.InputJsonValue,
  });

  return { outcome: "SUCCESS", analytics, analysis: result.data };
}
