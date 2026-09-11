import { prisma } from "../db/client.js";
import { NOT_IN_100 } from "../excel/mapping.js";

// Pure reporting analytics -- reads ranking_rows, never writes to them, never
// touches ranking_runs/RunStatus/RowStatus, never imports anything from
// backend/worker or backend/statemachine. This is deliberately isolated from
// the ranking pipeline: it's a read-only consumer of already-completed data.

export interface AnalyticsTotals {
  totalKeywords: number;
  averageRank: number | null;
  top3Count: number;
  top10Count: number;
  notIn100Count: number;
}

export interface KeywordMovement {
  keyword: string;
  rowUid: string;
  previousRank: number | null;
  currentRank: number | null;
  delta: number | null;
}

export interface NewlyTrackedKeyword {
  keyword: string;
  rowUid: string;
  currentRank: number | null;
}

export interface RunAnalytics {
  runId: string;
  previousRunId: string | null;
  totals: AnalyticsTotals;
  /** The previous run's own totals (same shape as `totals`), computed from the same rows already fetched for movements -- null when there's no previous run to compare against. */
  previousTotals: AnalyticsTotals | null;
  movements: {
    improved: KeywordMovement[];
    declined: KeywordMovement[];
    unchanged: KeywordMovement[];
    newlyTracked: NewlyTrackedKeyword[];
  };
}

// Exported so compareRunToBaseline.ts (backend/baselines/) can reuse the
// exact same rank-delta classification against a differently-sourced
// "previous" side (a RankingBaseline's rows, keyed by normalized keyword
// instead of rowUid) without reimplementing the improved/declined/
// unchanged/newlyTracked rules. `rowUid` here is just "the join key used
// for this comparison" -- for a real run-to-run comparison that's the
// actual RankingRow.rowUid; for a baseline comparison the caller populates
// it with the normalized keyword instead.
export interface RankRow {
  keyword: string;
  rowUid: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeTotals(rows: RankRow[]): AnalyticsTotals {
  const ranked = rows.filter((r) => r.rankValue !== null);
  const notIn100 = rows.filter((r) => r.rankDisplay === NOT_IN_100);

  const averageRank =
    ranked.length > 0
      ? round1(ranked.reduce((sum, r) => sum + (r.rankValue as number), 0) / ranked.length)
      : null;

  return {
    totalKeywords: rows.length,
    averageRank,
    top3Count: ranked.filter((r) => (r.rankValue as number) <= 3).length,
    top10Count: ranked.filter((r) => (r.rankValue as number) <= 10).length,
    notIn100Count: notIn100.length,
  };
}

export function computeMovements(currentRows: RankRow[], previousRows: RankRow[]) {
  const previousByUid = new Map(previousRows.map((r) => [r.rowUid, r]));

  const improved: KeywordMovement[] = [];
  const declined: KeywordMovement[] = [];
  const unchanged: KeywordMovement[] = [];
  const newlyTracked: NewlyTrackedKeyword[] = [];

  for (const current of currentRows) {
    const previous = previousByUid.get(current.rowUid);

    if (!previous) {
      newlyTracked.push({
        keyword: current.keyword,
        rowUid: current.rowUid,
        currentRank: current.rankValue,
      });
      continue;
    }

    const previousRank = previous.rankValue;
    const currentRank = current.rankValue;
    const delta = previousRank !== null && currentRank !== null ? previousRank - currentRank : null;
    const entry: KeywordMovement = { keyword: current.keyword, rowUid: current.rowUid, previousRank, currentRank, delta };

    // Lower rank number is better. A transition to/from "Not in 100" (null)
    // counts as improved/declined, not unchanged -- only both-null or
    // identical-numeric counts as unchanged.
    if (previousRank === null && currentRank === null) {
      unchanged.push(entry);
    } else if (previousRank === null) {
      improved.push(entry); // was Not in 100, now ranked
    } else if (currentRank === null) {
      declined.push(entry); // was ranked, now Not in 100
    } else if (currentRank < previousRank) {
      improved.push(entry);
    } else if (currentRank > previousRank) {
      declined.push(entry);
    } else {
      unchanged.push(entry);
    }
  }

  return { improved, declined, unchanged, newlyTracked };
}

export async function computeRunAnalytics(runId: string, previousRunId?: string): Promise<RunAnalytics> {
  const currentRows: RankRow[] = await prisma.rankingRow.findMany({
    where: { runId },
    select: { keyword: true, rowUid: true, rankValue: true, rankDisplay: true },
  });

  const totals = computeTotals(currentRows);

  // No previous run (a brand-new client's very first run) is NOT "nothing to
  // report" -- every current keyword must still show up, classified as
  // newlyTracked, exactly like compareRunToBaseline.ts already does when
  // there's no baseline either. computeMovements handles an empty
  // previousRows correctly on its own (every current row falls through to
  // newlyTracked); previousTotals staying null is the only thing that's
  // genuinely specific to "no previous side" -- there's no previous data to
  // summarize.
  let previousRows: RankRow[] = [];
  let previousTotals: AnalyticsTotals | null = null;

  if (previousRunId) {
    previousRows = await prisma.rankingRow.findMany({
      where: { runId: previousRunId },
      select: { keyword: true, rowUid: true, rankValue: true, rankDisplay: true },
    });
    previousTotals = computeTotals(previousRows);
  }

  const movements = computeMovements(currentRows, previousRows);

  return { runId, previousRunId: previousRunId ?? null, totals, previousTotals, movements };
}
