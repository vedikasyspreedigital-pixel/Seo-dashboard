import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRowsAndSummary } from "../backend/reporting/generateClientReportPdf.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";

// Pure logic, no DB/Playwright -- mirrors how computeRunAnalytics.test.mjs-
// style files test the math in isolation from I/O.

function analytics(overrides: Partial<RunAnalytics["movements"]>): RunAnalytics {
  return {
    runId: "run-1",
    previousRunId: "run-0",
    totals: { totalKeywords: 0, averageRank: null, top3Count: 0, top10Count: 0, notIn100Count: 0 },
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

test("buildRowsAndSummary: unranked-to-ranked (both 'improved with no previous rank' and newlyTracked) count as New, not Improved", () => {
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

  // Both land under "Newly Ranked", NOT "Improved" -- this is what keeps
  // the 5 summary buckets non-overlapping.
  assert.equal(summary.newlyRanked, 2);
  assert.equal(summary.improved, 0);
});

test("buildRowsAndSummary: ranked-to-unranked shows 'Lost' text but still counts under Dropped (no separate Lost summary bucket)", () => {
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
  assert.equal(summary.dropped, 1); // folded into Dropped, not a separate bucket
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

test("buildRowsAndSummary: the 5 summary counts always sum to Total Keywords -- no double counting, no gaps", () => {
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
  assert.equal(summary.improved + summary.dropped + summary.unchanged + summary.newlyRanked, summary.totalKeywords);
  assert.equal(summary.improved, 1);
  assert.equal(summary.dropped, 2);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.newlyRanked, 2);
});
