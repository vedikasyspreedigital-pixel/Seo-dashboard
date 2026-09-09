import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRowsAndSummary, describeOverallRankingChange } from "../backend/reporting/generateClientReportPdf.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";

// Pure logic, no DB/Playwright -- mirrors how computeRunAnalytics.test.mjs-
// style files test the math in isolation from I/O.

function analytics(overrides: Partial<RunAnalytics["movements"]>, previousAverageRank: number | null = null): RunAnalytics {
  return {
    runId: "run-1",
    previousRunId: "run-0",
    totals: { totalKeywords: 0, averageRank: null, top3Count: 0, top10Count: 0, notIn100Count: 0 },
    previousTotals: previousAverageRank === null ? null : { totalKeywords: 0, averageRank: previousAverageRank, top3Count: 0, top10Count: 0, notIn100Count: 0 },
    movements: { improved: [], declined: [], unchanged: [], newlyTracked: [], ...overrides },
  };
}

test("buildRowsAndSummary: numeric improvement/decline get exact deltas, both signs and colors implied by kind", () => {
  const a = analytics({
    improved: [{ keyword: "commercial whirlybirds", rowUid: "r1", previousRank: 14, currentRank: 8, delta: 6 }],
    declined: [{ keyword: "roof ventilation", rowUid: "r2", previousRank: 8, currentRank: 17, delta: -9 }],
  });
  a.totals.totalKeywords = 2;

  const { rows, summary } = buildRowsAndSummary(a);
  const improvedRow = rows.find((r) => r.keyword === "commercial whirlybirds")!;
  const declinedRow = rows.find((r) => r.keyword === "roof ventilation")!;

  assert.equal(improvedRow.previousRankLabel, "14");
  assert.equal(improvedRow.currentRankLabel, "8");
  assert.equal(improvedRow.movementLabel, "↑ +6");
  assert.equal(improvedRow.kind, "improved");

  assert.equal(declinedRow.movementLabel, "↓ -9");
  assert.equal(declinedRow.kind, "dropped");

  assert.equal(summary.improved, 1);
  assert.equal(summary.dropped, 1);
});

test("buildRowsAndSummary: unranked-to-ranked (both 'improved with no previous rank' and newlyTracked) count as Entered Top 100, not Improved", () => {
  const a = analytics({
    improved: [{ keyword: "roof exhaust fan", rowUid: "r1", previousRank: null, currentRank: 42, delta: null }],
    newlyTracked: [{ keyword: "brand new keyword", rowUid: "r2", currentRank: 55 }],
  });
  a.totals.totalKeywords = 2;

  const { rows, summary } = buildRowsAndSummary(a);
  const fromUnranked = rows.find((r) => r.keyword === "roof exhaust fan")!;
  const brandNew = rows.find((r) => r.keyword === "brand new keyword")!;

  assert.equal(fromUnranked.previousRankLabel, "Not in 100");
  assert.equal(fromUnranked.movementLabel, "↑ New");
  assert.equal(fromUnranked.kind, "new");
  assert.equal(brandNew.previousRankLabel, "Not in 100");
  assert.equal(brandNew.movementLabel, "↑ New");

  // Both land under "Entered Top 100", NOT "Improved" -- this is what keeps
  // the summary buckets non-overlapping.
  assert.equal(summary.enteredTop100, 2);
  assert.equal(summary.improved, 0);
});

test("buildRowsAndSummary: ranked-to-unranked shows 'Lost' text and counts under Dropped Out of Top 100, NOT the plain Dropped bucket", () => {
  const a = analytics({
    declined: [{ keyword: "seasonal keyword", rowUid: "r1", previousRank: 42, currentRank: null, delta: null }],
  });
  a.totals.totalKeywords = 1;

  const { rows, summary } = buildRowsAndSummary(a);
  const row = rows[0];

  assert.equal(row.previousRankLabel, "42");
  assert.equal(row.currentRankLabel, "Not in 100");
  assert.equal(row.movementLabel, "↓ Lost");
  assert.equal(row.kind, "lost");
  assert.equal(summary.droppedOutOfTop100, 1);
  assert.equal(summary.dropped, 0, "a keyword that fully dropped out of the top 100 is a distinct bucket, not folded into plain Dropped");
});

test("buildRowsAndSummary: unchanged keyword shows '→ 0'", () => {
  const a = analytics({
    unchanged: [{ keyword: "roof whirlybird", rowUid: "r1", previousRank: 12, currentRank: 12, delta: 0 }],
  });
  a.totals.totalKeywords = 1;

  const { rows, summary } = buildRowsAndSummary(a);
  assert.equal(rows[0].movementLabel, "→ 0");
  assert.equal(rows[0].kind, "unchanged");
  assert.equal(summary.unchanged, 1);
});

test("buildRowsAndSummary: the 6 non-overlapping summary counts always sum to Total Keywords -- no double counting, no gaps", () => {
  const a = analytics({
    improved: [
      { keyword: "a", rowUid: "1", previousRank: 20, currentRank: 10, delta: 10 },
      { keyword: "b", rowUid: "2", previousRank: null, currentRank: 30, delta: null },
    ],
    declined: [
      { keyword: "c", rowUid: "3", previousRank: 5, currentRank: 15, delta: -10 },
      { keyword: "d", rowUid: "4", previousRank: 8, currentRank: null, delta: null },
    ],
    unchanged: [{ keyword: "e", rowUid: "5", previousRank: 3, currentRank: 3, delta: 0 }],
    newlyTracked: [{ keyword: "f", rowUid: "6", currentRank: 90 }],
  });
  a.totals.totalKeywords = 6;

  const { rows, summary } = buildRowsAndSummary(a);
  assert.equal(rows.length, 6);
  assert.equal(
    summary.improved + summary.dropped + summary.unchanged + summary.enteredTop100 + summary.droppedOutOfTop100,
    summary.totalKeywords,
  );
  assert.equal(summary.improved, 1);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.droppedOutOfTop100, 1);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.enteredTop100, 2);
});

test("buildRowsAndSummary: previous/current average rank and the overall change come from previousTotals/totals directly", () => {
  const a = analytics({}, 20.5);
  a.totals.averageRank = 14.3;

  const { summary } = buildRowsAndSummary(a);
  assert.equal(summary.previousAverageRank, 20.5);
  assert.equal(summary.currentAverageRank, 14.3);
  assert.equal(summary.overallRankingChange, "↑ Improved by 6.2 positions");
});

test("buildRowsAndSummary: no previous run -> previousAverageRank is null and overall change is 'No change'", () => {
  const a = analytics({}, null);
  a.totals.averageRank = 14.3;

  const { summary } = buildRowsAndSummary(a);
  assert.equal(summary.previousAverageRank, null);
  assert.equal(summary.overallRankingChange, "No change");
});

test("describeOverallRankingChange: human-readable, never raw signed arithmetic -- lower rank is better", () => {
  assert.equal(describeOverallRankingChange(20, 14), "↑ Improved by 6 positions");
  assert.equal(describeOverallRankingChange(14, 20), "↓ Declined by 6 positions");
  assert.equal(describeOverallRankingChange(14, 14), "No change");
  assert.equal(describeOverallRankingChange(null, 14), "No change");
  assert.equal(describeOverallRankingChange(14, null), "No change");
});

test("describeOverallRankingChange: singular 'position' for exactly 1", () => {
  assert.equal(describeOverallRankingChange(15, 14), "↑ Improved by 1 position");
  assert.equal(describeOverallRankingChange(14, 15), "↓ Declined by 1 position");
});
