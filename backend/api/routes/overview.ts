import { Router } from "express";
import { prisma } from "../../db/client.js";
import { RunStatus, Prisma } from "@prisma/client";
import { requireAuth } from "../../auth/requireAuth.js";

// Cross-client aggregate data for the "Overall Overview" homepage. Entirely
// real data -- every number here is a direct count/sum from the same
// tables the rest of the app reads (ranking_runs, ranking_reports,
// clients). Nothing here is estimated, fabricated, or Claude-authored.
//
// Two different aggregation choices, deliberate and documented inline:
//   - KPI totals (ranking movements, keywords tracked) use each client's
//     MOST RECENT report only, so a client with many historical reports
//     doesn't inflate the numbers -- this represents current state, not
//     cumulative history.
//   - The daily trend series uses ALL reports (not deduped per client),
//     since it's meant to show report-generation activity over time.

export const overviewRouter = Router();

overviewRouter.use(requireAuth);

overviewRouter.get("/", async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    res.status(400).json({ error: "workspaceId query parameter is required" });
    return;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: "You do not have access to this workspace" });
    return;
  }

  // Optional client scope -- the dashboard's KPI tiles/chart/recent-runs
  // reflect whichever client is currently active, not the whole workspace
  // (previously this endpoint was always workspace-wide, which is what
  // produced the "switching clients doesn't update the numbers" bug: the
  // frontend's ClientDetailsCard reacted to the active client immediately,
  // but every other tile on the same page silently kept showing
  // workspace-wide totals). When omitted, falls back to the original
  // workspace-wide aggregate (kept for any other consumer).
  const clientId = req.query.clientId;
  if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) {
    res.status(400).json({ error: "clientId query parameter must be a non-empty string when provided" });
    return;
  }
  if (typeof clientId === "string") {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client || client.workspaceId !== workspaceId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
  }

  // Same scoping as clients.ts: only this workspace's real (non-test)
  // clients feed every aggregate below, additionally narrowed to one
  // client when clientId is given.
  const clientScope = { workspaceId, isTestData: false, ...(typeof clientId === "string" ? { id: clientId } : {}) } as const;

  const [totalClients, totalRuns, totalSuccessfulRuns, recentRunsRaw, allReports] = await Promise.all([
    prisma.client.count({ where: { isActive: true, workspaceId, isTestData: false } }), // deliberately always workspace-wide -- "how many clients total" doesn't mean anything scoped to one client
    prisma.rankingRun.count({ where: { client: clientScope } }),
    prisma.rankingRun.count({ where: { status: RunStatus.COMPLETED, client: clientScope } }),
    prisma.rankingRun.findMany({
      where: { client: clientScope },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { client: { select: { name: true } } },
    }),
    prisma.rankingReport.findMany({
      where: { analyticsJson: { not: Prisma.DbNull }, client: clientScope },
      select: { clientId: true, createdAt: true, analyticsJson: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Latest report per client, for the "current state" KPI totals.
  const latestPerClient = new Map<string, (typeof allReports)[number]>();
  for (const report of allReports) {
    if (!latestPerClient.has(report.clientId)) latestPerClient.set(report.clientId, report);
  }

  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let totalKeywordsTracked = 0;
  let top3Count = 0;
  let top10Count = 0;
  let notIn100Count = 0;
  const averageRanks: number[] = [];
  for (const report of latestPerClient.values()) {
    const analytics = report.analyticsJson as unknown as {
      totals?: { totalKeywords?: number; top3Count?: number; top10Count?: number; notIn100Count?: number; averageRank?: number | null };
      movements?: { improved?: unknown[]; declined?: unknown[]; unchanged?: unknown[] };
    } | null;
    if (!analytics) continue;
    improved += analytics.movements?.improved?.length ?? 0;
    declined += analytics.movements?.declined?.length ?? 0;
    unchanged += analytics.movements?.unchanged?.length ?? 0;
    totalKeywordsTracked += analytics.totals?.totalKeywords ?? 0;
    top3Count += analytics.totals?.top3Count ?? 0;
    top10Count += analytics.totals?.top10Count ?? 0;
    notIn100Count += analytics.totals?.notIn100Count ?? 0;
    if (typeof analytics.totals?.averageRank === "number") averageRanks.push(analytics.totals.averageRank);
  }
  const averageRank = averageRanks.length > 0 ? Math.round((averageRanks.reduce((a, b) => a + b, 0) / averageRanks.length) * 10) / 10 : null;

  // Daily trend: every report (not deduped), bucketed by the day it was
  // generated -- shows real report-generation activity over time.
  const byDay = new Map<string, { improved: number; declined: number; unchanged: number }>();
  for (const report of allReports) {
    const day = report.createdAt.toISOString().slice(0, 10);
    const analytics = report.analyticsJson as unknown as {
      movements?: { improved?: unknown[]; declined?: unknown[]; unchanged?: unknown[] };
    } | null;
    if (!analytics) continue;
    const bucket = byDay.get(day) ?? { improved: 0, declined: 0, unchanged: 0 };
    bucket.improved += analytics.movements?.improved?.length ?? 0;
    bucket.declined += analytics.movements?.declined?.length ?? 0;
    bucket.unchanged += analytics.movements?.unchanged?.length ?? 0;
    byDay.set(day, bucket);
  }
  const dailyMovements = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  const recentRuns = recentRunsRaw.map((run) => ({
    id: run.id,
    clientName: run.client.name,
    sourceFilename: run.sourceFilename,
    status: run.status,
    totalRows: run.totalRows,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  }));

  res.json({
    totalClients,
    totalRuns,
    totalSuccessfulRuns,
    totalKeywordsTracked,
    top3Count,
    top10Count,
    notIn100Count,
    averageRank,
    rankingMovements: { improved, declined, unchanged },
    dailyMovements,
    recentRuns,
  });
});
