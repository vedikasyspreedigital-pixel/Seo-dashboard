import { RunStatus, type Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeRunAnalytics } from "./computeRunAnalytics.js";

// The API/service wiring that turns a completed RankingRun into a
// RankingReport. Deliberately thin: it only decides *whether* a report can
// be created and *which* run to compare against, then stores the report at
// PENDING_ANALYSIS with analyticsJson eagerly populated (pure backend code,
// computeRunAnalytics -- no Claude call) so the wizard's Analytics Preview
// step has something to show. It does NOT run the Claude analyst -- that is
// a separate, explicit step (see generateInsights.ts), matching the
// reference design's "the Claude call happens only when you generate
// insights" checkpoint.
const REPORTABLE_RUN_STATUSES: RunStatus[] = [RunStatus.COMPLETED, RunStatus.COMPLETED_WITH_ERRORS];

export type CreateReportResult =
  | { outcome: "SUCCESS"; report: NonNullable<Awaited<ReturnType<typeof prisma.rankingReport.findUnique>>> }
  | { outcome: "RUN_NOT_FOUND" }
  | { outcome: "RUN_NOT_COMPLETED"; runStatus: RunStatus }
  | { outcome: "DUPLICATE_REPORT"; existingReportId: string };

export async function createReportForRun(runId: string, previousRunId?: string): Promise<CreateReportResult> {
  const run = await prisma.rankingRun.findUnique({ where: { id: runId } });
  if (!run) return { outcome: "RUN_NOT_FOUND" };
  if (!REPORTABLE_RUN_STATUSES.includes(run.status)) {
    return { outcome: "RUN_NOT_COMPLETED", runStatus: run.status };
  }

  const existing = await prisma.rankingReport.findFirst({ where: { runId } });
  if (existing) return { outcome: "DUPLICATE_REPORT", existingReportId: existing.id };

  // Comparison target: an explicit choice from the caller (the wizard's
  // "Compare against previous run" picker) if given, otherwise best-effort
  // fall back to the most recently completed prior run for the same client.
  // Neither is required -- computeRunAnalytics handles a null previousRunId
  // fine (empty movements, no invented "improved/declined").
  let resolvedPreviousRunId: string | null = null;
  if (previousRunId) {
    const chosen = await prisma.rankingRun.findFirst({
      where: { id: previousRunId, clientId: run.clientId, status: { in: REPORTABLE_RUN_STATUSES } },
    });
    resolvedPreviousRunId = chosen?.id ?? null;
  } else {
    const latest = await prisma.rankingRun.findFirst({
      where: {
        clientId: run.clientId,
        id: { not: run.id },
        status: { in: REPORTABLE_RUN_STATUSES },
        completedAt: { lt: run.completedAt ?? run.createdAt },
      },
      orderBy: { completedAt: "desc" },
    });
    resolvedPreviousRunId = latest?.id ?? null;
  }

  const analytics = await computeRunAnalytics(runId, resolvedPreviousRunId ?? undefined);

  const created = await prisma.rankingReport.create({
    data: {
      runId: run.id,
      clientId: run.clientId,
      previousRunId: resolvedPreviousRunId,
      analyticsJson: analytics as unknown as Prisma.InputJsonValue,
    },
  });

  return { outcome: "SUCCESS", report: created };
}
