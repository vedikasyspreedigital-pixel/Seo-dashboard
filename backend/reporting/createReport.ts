import { RunStatus, type Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeRunAnalytics } from "./computeRunAnalytics.js";
import { compareRunToBaseline } from "../baselines/compareRunToBaseline.js";

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

export async function createReportForRun(
  runId: string,
  previousRunId?: string,
  previousBaselineId?: string,
): Promise<CreateReportResult> {
  const run = await prisma.rankingRun.findUnique({ where: { id: runId } });
  if (!run) return { outcome: "RUN_NOT_FOUND" };
  if (!REPORTABLE_RUN_STATUSES.includes(run.status)) {
    return { outcome: "RUN_NOT_COMPLETED", runStatus: run.status };
  }

  const existing = await prisma.rankingReport.findFirst({ where: { runId } });
  if (existing) return { outcome: "DUPLICATE_REPORT", existingReportId: existing.id };

  // Comparison target: an explicit choice from the caller (a prior real
  // run, or an imported baseline -- mutually exclusive) if given, otherwise
  // best-effort fallback: the most recently completed prior run for this
  // client, or -- if there is no prior run at all, e.g. this is the
  // client's very first run -- their most recently uploaded baseline, so a
  // freshly onboarded client's first-ever report automatically compares
  // against their imported ranking history without the caller needing to
  // know which case applies. Neither is required -- computeRunAnalytics/
  // compareRunToBaseline both handle "nothing to compare against" fine
  // (empty movements, no invented improved/declined).
  let resolvedPreviousRunId: string | null = null;
  let resolvedPreviousBaselineId: string | null = null;

  if (previousRunId) {
    const chosen = await prisma.rankingRun.findFirst({
      where: { id: previousRunId, clientId: run.clientId, status: { in: REPORTABLE_RUN_STATUSES } },
    });
    resolvedPreviousRunId = chosen?.id ?? null;
  } else if (previousBaselineId) {
    const chosen = await prisma.rankingBaseline.findFirst({ where: { id: previousBaselineId, clientId: run.clientId } });
    resolvedPreviousBaselineId = chosen?.id ?? null;
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
    if (latest) {
      resolvedPreviousRunId = latest.id;
    } else {
      const latestBaseline = await prisma.rankingBaseline.findFirst({
        where: { clientId: run.clientId },
        orderBy: { createdAt: "desc" },
      });
      resolvedPreviousBaselineId = latestBaseline?.id ?? null;
    }
  }

  const analytics = resolvedPreviousBaselineId
    ? await compareRunToBaseline(runId, resolvedPreviousBaselineId)
    : await computeRunAnalytics(runId, resolvedPreviousRunId ?? undefined);

  const created = await prisma.rankingReport.create({
    data: {
      runId: run.id,
      clientId: run.clientId,
      previousRunId: resolvedPreviousRunId,
      previousBaselineId: resolvedPreviousBaselineId,
      analyticsJson: analytics as unknown as Prisma.InputJsonValue,
    },
  });

  return { outcome: "SUCCESS", report: created };
}
