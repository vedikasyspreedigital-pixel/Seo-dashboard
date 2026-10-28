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

  // The movement counts are worked out IN the database: every report's whole analysis (all keywords) used
  // to be loaded on each visit just to count its arrows, so the page got slower with every report ever
  // made (audit 2026-10-27). Same numbers, same chart -- only the counts come back.
  const clientFilter = typeof clientId === "string" ? Prisma.sql`AND c.id = ${clientId}` : Prisma.empty;
  const moved = (kind: string) =>
    Prisma.sql`COALESCE(CASE WHEN jsonb_typeof(r.analytics_json->'movements'->${kind}) = 'array' THEN jsonb_array_length(r.analytics_json->'movements'->${kind}) END, 0)`;
  const reportScope = Prisma.sql`FROM ranking_reports r JOIN clients c ON c.id = r.client_id
    WHERE r.analytics_json IS NOT NULL AND c.workspace_id = ${workspaceId} AND c.is_test_data = false ${clientFilter}`;

  const [totalClients, totalRuns, totalSuccessfulRuns, recentRunsRaw, latestReports, dailyRows] = await Promise.all([
    prisma.client.count({ where: { isActive: true, workspaceId, isTestData: false } }), // deliberately always workspace-wide -- "how many clients total" doesn't mean anything scoped to one client
    prisma.rankingRun.count({ where: { client: clientScope } }),
    prisma.rankingRun.count({ where: { status: RunStatus.COMPLETED, client: clientScope } }),
    prisma.rankingRun.findMany({
      where: { client: clientScope },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { client: { select: { name: true } } },
    }),
    // Latest report per client, for the "current state" KPI totals: its totals + movement counts only.
    prisma.$queryRaw<{ totals: unknown; improved: number; declined: number; unchanged: number }[]>`
      SELECT DISTINCT ON (r.client_id) r.analytics_json->'totals' AS totals,
        ${moved("improved")}::int AS improved, ${moved("declined")}::int AS declined, ${moved("unchanged")}::int AS unchanged
      ${reportScope}
      ORDER BY r.client_id, r.created_at DESC`,
    // Daily trend: every report (not deduped), bucketed by the (UTC) day it was generated.
    prisma.$queryRaw<{ date: string; improved: number; declined: number; unchanged: number }[]>`
      SELECT to_char(r.created_at, 'YYYY-MM-DD') AS date,
        SUM(${moved("improved")})::int AS improved, SUM(${moved("declined")})::int AS declined, SUM(${moved("unchanged")})::int AS unchanged
      ${reportScope}
      GROUP BY 1 ORDER BY 1`,
  ]);

  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let totalKeywordsTracked = 0;
  let top3Count = 0;
  let top10Count = 0;
  let notIn100Count = 0;
  const averageRanks: number[] = [];
  for (const report of latestReports) {
    const totals = report.totals as { totalKeywords?: number; top3Count?: number; top10Count?: number; notIn100Count?: number; averageRank?: number | null } | null;
    improved += report.improved;
    declined += report.declined;
    unchanged += report.unchanged;
    totalKeywordsTracked += totals?.totalKeywords ?? 0;
    top3Count += totals?.top3Count ?? 0;
    top10Count += totals?.top10Count ?? 0;
    notIn100Count += totals?.notIn100Count ?? 0;
    if (typeof totals?.averageRank === "number") averageRanks.push(totals.averageRank);
  }
  const averageRank = averageRanks.length > 0 ? Math.round((averageRanks.reduce((a, b) => a + b, 0) / averageRanks.length) * 10) / 10 : null;

  const dailyMovements = dailyRows.map(({ date, improved, declined, unchanged }) => ({ date, improved, declined, unchanged }));

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
