import { prisma } from "../db/client.js";
import { computeMovements, computeTotals, type RankRow } from "../reporting/computeRunAnalytics.js";
import type { RunAnalytics } from "../reporting/computeRunAnalytics.js";
import { normalizeKeyword } from "./normalizeKeyword.js";

/**
 * Same shape as RunAnalytics (computeRunAnalytics.ts) so it drops straight
 * into the existing report pipeline (buildRowsAndSummary, generateClientReportPdf)
 * with zero changes there -- previousRunId is always null here (the
 * "previous" side is a RankingBaseline, not a RankingRun); the report itself
 * records which baseline was used via RankingReport.previousBaselineId.
 *
 * Matching key is normalized keyword (see normalizeKeyword.ts), not rowUid --
 * a baseline row has no targetUrl/locationName/seDomain/languageName to
 * build a real rowUid from. Reuses computeMovements/computeTotals as-is by
 * populating RankRow.rowUid with the normalized keyword instead of an actual
 * row UID; the classification rules (ranked<->ranked, null<->ranked
 * transitions, unchanged) are identical either way. Duplicate normalized
 * keywords on either side collapse to the last one in iteration order, same
 * pre-existing behavior as rowUid-based matching -- not a new limitation
 * introduced here.
 */
export async function compareRunToBaseline(runId: string, baselineId: string): Promise<RunAnalytics> {
  const [currentRowsRaw, baseline] = await Promise.all([
    prisma.rankingRow.findMany({
      where: { runId },
      select: { keyword: true, rankValue: true, rankDisplay: true },
    }),
    prisma.rankingBaseline.findUniqueOrThrow({
      where: { id: baselineId },
      include: { rows: true },
    }),
  ]);

  const currentRows: RankRow[] = currentRowsRaw.map((r) => ({
    keyword: r.keyword,
    rowUid: normalizeKeyword(r.keyword),
    rankValue: r.rankValue,
    rankDisplay: r.rankDisplay,
  }));
  const previousRows: RankRow[] = baseline.rows.map((r) => ({
    keyword: r.keyword,
    rowUid: r.normalizedKeyword,
    rankValue: r.rankValue,
    rankDisplay: r.rankDisplay,
  }));

  const totals = computeTotals(currentRows);
  const previousTotals = computeTotals(previousRows);
  const movements = computeMovements(currentRows, previousRows);

  return { runId, previousRunId: null, totals, previousTotals, hasComparison: true, movements };
}
