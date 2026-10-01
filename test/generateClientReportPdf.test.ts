import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRowsAndSummary, describeOverallRankingChange, formatSearchEngineLabel, groupRowsByLocation, buildClientReportHtml } from "../backend/reporting/generateClientReportPdf.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";

// Pure logic, no DB/Playwright -- mirrors how computeRunAnalytics.test.mjs-
// style files test the math in isolation from I/O.

function analytics(overrides: Partial<RunAnalytics["movements"]>, previousAverageRank: number | null = null): RunAnalytics {
  return {
    runId: "run-1",
    previousRunId: "run-0",
    totals: { totalKeywords: 0, averageRank: null, top3Count: 0, top10Count: 0, notIn100Count: 0 },
    previousTotals: previousAverageRank === null ? null : { totalKeywords: 0, averageRank: previousAverageRank, top3Count: 0, top10Count: 0, notIn100Count: 0 },
    hasComparison: true,
    movements: { improved: [], declined: [], unchanged: [], newlyTracked: [], ...overrides },
  };
}

/** A brand-new client's first-ever run -- real current data, no comparison side at all. */
function noComparisonAnalytics(newlyTracked: RunAnalytics["movements"]["newlyTracked"]): RunAnalytics {
  const totalKeywords = newlyTracked.length;
  const ranked = newlyTracked.filter((m) => m.currentRank !== null).map((m) => m.currentRank as number);
  return {
    runId: "run-1",
    previousRunId: null,
    totals: {
      totalKeywords,
      averageRank: ranked.length > 0 ? Math.round((ranked.reduce((a, b) => a + b, 0) / ranked.length) * 10) / 10 : null,
      top3Count: ranked.filter((r) => r <= 3).length,
      top10Count: ranked.filter((r) => r <= 10).length,
      notIn100Count: newlyTracked.filter((m) => m.currentRank === null).length,
    },
    previousTotals: null,
    hasComparison: false,
    movements: { improved: [], declined: [], unchanged: [], newlyTracked },
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

test("buildRowsAndSummary: ranked keywords come first in ascending rank order, then a 'Not in 100' tail -- never interleaved", () => {
  const a = analytics({
    improved: [
      { keyword: "improved-high-rank", rowUid: "1", previousRank: 50, currentRank: 42, delta: 8 },
      { keyword: "improved-low-rank", rowUid: "2", previousRank: 20, currentRank: 3, delta: 17 },
    ],
    declined: [
      { keyword: "declined-mid-rank", rowUid: "3", previousRank: 5, currentRank: 15, delta: -10 },
      { keyword: "fell-out-of-100", rowUid: "4", previousRank: 8, currentRank: null, delta: null },
    ],
    unchanged: [{ keyword: "steady-rank", rowUid: "5", previousRank: 3, currentRank: 3, delta: 0 }],
    newlyTracked: [{ keyword: "still-not-ranked", rowUid: "6", currentRank: null }],
  });
  a.totals.totalKeywords = 6;

  const { rows } = buildRowsAndSummary(a);

  // Ranked rows (currentRank !== null) must all appear before any "Not in
  // 100" row (currentRank === null), and must be ascending by rank.
  const firstNotIn100Index = rows.findIndex((r) => r.currentRank === null);
  assert.notEqual(firstNotIn100Index, -1);
  const rankedSlice = rows.slice(0, firstNotIn100Index);
  const notIn100Slice = rows.slice(firstNotIn100Index);

  assert.ok(rankedSlice.every((r) => r.currentRank !== null), "no Not-in-100 row appears before the tail starts");
  assert.ok(notIn100Slice.every((r) => r.currentRank === null), "no ranked row appears after the tail starts");
  assert.deepEqual(
    rankedSlice.map((r) => r.currentRank),
    [3, 3, 15, 42],
    "ranked rows are ascending by currentRank",
  );
  assert.equal(notIn100Slice.length, 2);
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

// Regression tests for the "new client, no previous ranking" requirement:
// the report must show a normal, populated current-ranking table -- NOT an
// empty one (the original bug), and NOT one dressed up in comparison
// language like "Entered Top 100" / "↑ New" (a subtler version of the same
// bug: implying a before-state that never existed).
test("buildRowsAndSummary: hasComparison=false renders every current keyword with its real rank, no comparison labels", () => {
  const a = noComparisonAnalytics([
    { keyword: "first-ever-kw", rowUid: "first-ever-kw", currentRank: 4 },
    { keyword: "another-kw", rowUid: "another-kw", currentRank: 22 },
    { keyword: "not-ranked-kw", rowUid: "not-ranked-kw", currentRank: null },
  ]);

  const { rows, summary } = buildRowsAndSummary(a);

  assert.equal(rows.length, 3, "a first-ever run's report must show every keyword, not an empty table");
  const first = rows.find((r) => r.keyword === "first-ever-kw")!;
  assert.equal(first.currentRankLabel, "4");
  assert.equal(first.previousRankLabel, "—", "no previous rank should be asserted -- there was no previous run to have one");
  assert.equal(first.movementLabel, "—", "no movement/comparison label should be asserted -- nothing was compared");

  assert.equal(summary.hasComparison, false);
  assert.equal(summary.totalKeywords, 3);
  assert.equal(summary.improved, 0);
  assert.equal(summary.dropped, 0);
  assert.equal(summary.enteredTop100, 0, "must not claim keywords 'entered' the top 100 -- there's no before-state they entered from");
  assert.equal(summary.previousAverageRank, null);
  assert.equal(summary.top3Count, 0);
  assert.equal(summary.top10Count, 1);
  assert.equal(summary.notIn100Count, 1);
});

// Regression: the table's search-engine header row was hardcoded to
// "Google.ae" for every client -- found on an Australian client's report
// (arnoldsfibreglass.com.au, searched on google.com.au) showing Google.ae.
test("formatSearchEngineLabel: shows the run's real Google domain, not a hardcoded Google.ae", () => {
  assert.equal(formatSearchEngineLabel(["google.com.au"]), "Google.com.au");
  assert.equal(formatSearchEngineLabel(["google.ae"]), "Google.ae");
  assert.equal(formatSearchEngineLabel(["google.com.au", "Google.com.au "]), "Google.com.au", "same domain differing only by case/whitespace is one label");
  assert.equal(formatSearchEngineLabel(["google.com.au", "google.co.nz"]), "Google.com.au / Google.co.nz");
  assert.equal(formatSearchEngineLabel([]), "Google");
  assert.equal(formatSearchEngineLabel(undefined), "Google");
});

// -- Multi-location reports (reference: Twin Crown, 31 Aug - 15 Sep 2026) ----
// One table: the first location under the top "Current Ranking Status:"
// header, then a section row per further location, each group sorted on its own.

const TWIN_LOCATIONS = {
  order: ["United Arab Emirates|google.ae", "Saudi Arabia|google.com.sa", "Qatar|google.com.qa"],
  labels: {
    "United Arab Emirates|google.ae": { locationName: "United Arab Emirates", seDomain: "google.ae" },
    "Saudi Arabia|google.com.sa": { locationName: "Saudi Arabia", seDomain: "google.com.sa" },
    "Qatar|google.com.qa": { locationName: "Qatar", seDomain: "google.com.qa" },
  },
  byRowUid: {
    uae1: "United Arab Emirates|google.ae",
    uae2: "United Arab Emirates|google.ae",
    uae3: "United Arab Emirates|google.ae",
    ksa1: "Saudi Arabia|google.com.sa",
    ksa2: "Saudi Arabia|google.com.sa",
    qa1: "Qatar|google.com.qa",
  } as Record<string, string>,
};

function twinCrownAnalytics(): RunAnalytics {
  return analytics({
    improved: [
      { keyword: "flow meter suppliers in saudi arabia", rowUid: "ksa1", previousRank: 25, currentRank: 19, delta: 6 },
      { keyword: "oilfield equipment suppliers in dubai", rowUid: "uae2", previousRank: null, currentRank: 1, delta: null },
    ],
    declined: [{ keyword: "flow meter supplier in qatar", rowUid: "qa1", previousRank: 8, currentRank: 12, delta: -4 }],
    unchanged: [
      { keyword: "tcs meters uae", rowUid: "uae1", previousRank: 3, currentRank: 3, delta: 0 },
      { keyword: "submersible pump suppliers in dubai", rowUid: "uae3", previousRank: null, currentRank: null, delta: null },
      { keyword: "pump suppliers in saudi arabia", rowUid: "ksa2", previousRank: null, currentRank: null, delta: null },
    ],
  });
}

test("groupRowsByLocation: a single location (or no location data) is one flat group -- unchanged behavior", () => {
  const { rows } = buildRowsAndSummary(twinCrownAnalytics());
  assert.equal(groupRowsByLocation(rows, undefined).length, 1);
  const one = { order: ["Australia|google.com.au"], labels: { "Australia|google.com.au": { locationName: "Australia", seDomain: "google.com.au" } }, byRowUid: {} };
  const groups = groupRowsByLocation(rows, one);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, rows.length);
});

test("groupRowsByLocation: rows grouped in the Excel's location order, each group still ranked first then Not in 100", () => {
  const { rows } = buildRowsAndSummary(twinCrownAnalytics());
  const groups = groupRowsByLocation(rows, TWIN_LOCATIONS);
  assert.deepEqual(groups.map((g) => g.key), TWIN_LOCATIONS.order);
  assert.deepEqual(groups[0].rows.map((r) => r.keyword), ["oilfield equipment suppliers in dubai", "tcs meters uae", "submersible pump suppliers in dubai"]);
  assert.deepEqual(groups[1].rows.map((r) => r.keyword), ["flow meter suppliers in saudi arabia", "pump suppliers in saudi arabia"]);
  assert.deepEqual(groups[2].rows.map((r) => r.keyword), ["flow meter supplier in qatar"]);
});

test("groupRowsByLocation: a row with no known location falls into the first group, never dropped", () => {
  const { rows } = buildRowsAndSummary(twinCrownAnalytics());
  const groups = groupRowsByLocation(rows, { ...TWIN_LOCATIONS, byRowUid: { ...TWIN_LOCATIONS.byRowUid, qa1: "nowhere|google.xx" } });
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
});

test("PDF HTML: multi-location report has the first Google in the header and a section row per further location, in order", () => {
  const html = buildClientReportHtml({
    clientName: "Twin Crown",
    clientDomain: "twincrown.com",
    searchEngineDomains: ["google.ae", "google.com.sa", "google.com.qa"],
    locations: TWIN_LOCATIONS,
    currentRunDate: new Date("2026-09-15T00:00:00Z"),
    previousRunDate: new Date("2026-08-31T00:00:00Z"),
    analytics: twinCrownAnalytics(),
  });
  const header = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  assert.ok(header.includes(">Google.ae<"), "top header names the first location's Google only");
  assert.ok(!header.includes("Google.com.sa"), "not every domain joined into the header");
  const body = html.slice(html.indexOf("<tbody>"));
  const sections = [...body.matchAll(/<tr class="location-row">\s*<td>([^<]+)<\/td>\s*<td class="num">([^<]+)<\/td>/g)].map((m) => m[1] + " | " + m[2]);
  assert.deepEqual(sections, ["Saudi Arabia | google.com.sa", "Qatar | google.com.qa"], "no section row for the first location");
  const order = ["tcs meters uae", "Saudi Arabia", "flow meter suppliers in saudi arabia", "Qatar", "flow meter supplier in qatar"].map((t) => body.indexOf(t));
  assert.ok(order.every((pos, i) => pos > -1 && (i === 0 || pos > order[i - 1])), "UAE rows, then Saudi section + rows, then Qatar section + rows");
});

test("PDF HTML: a single-location report has no section rows", () => {
  const html = buildClientReportHtml({
    clientName: "Twin Crown",
    searchEngineDomains: ["google.ae"],
    locations: { order: ["United Arab Emirates|google.ae"], labels: { "United Arab Emirates|google.ae": { locationName: "United Arab Emirates", seDomain: "google.ae" } }, byRowUid: {} },
    currentRunDate: new Date("2026-09-15T00:00:00Z"),
    previousRunDate: new Date("2026-08-31T00:00:00Z"),
    analytics: twinCrownAnalytics(),
  });
  assert.ok(!html.includes('class="location-row"'));
  assert.ok(html.includes(">Google.ae<"));
});

// Regression: the orange header rows were printed again at the top of every
// page (Chromium repeats a table-header-group); the agency's reference
// reports show them once, on page 1 only.
test("PDF HTML: the orange header is printed once (row group), never repeated on every page", () => {
  const html = buildClientReportHtml({
    clientName: "Twin Crown",
    searchEngineDomains: ["google.ae"],
    currentRunDate: new Date("2026-09-15T00:00:00Z"),
    previousRunDate: new Date("2026-08-31T00:00:00Z"),
    analytics: twinCrownAnalytics(),
  });
  assert.match(html, /thead \{ display: table-row-group; \}/);
  assert.doesNotMatch(html, /table-header-group/);
});
