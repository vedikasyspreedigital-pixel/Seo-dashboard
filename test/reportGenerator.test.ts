import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReportHtml } from "../backend/reporting/reportGenerator.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";
import type { AnalystOutput } from "../backend/reporting/reportAnalyst.js";

// Pure unit tests -- no DB, no network, no Claude call.

const ANALYTICS: RunAnalytics = {
  runId: "run-1",
  previousRunId: null,
  totals: { totalKeywords: 3, averageRank: 15, top3Count: 0, top10Count: 1, notIn100Count: 1 },
  movements: {
    improved: [{ keyword: "cash for cars perth", rowUid: "u1", previousRank: 9, currentRank: 7, delta: 2 }],
    declined: [{ keyword: "car removal perth", rowUid: "u2", previousRank: 5, currentRank: 20, delta: -15 }],
    unchanged: [],
    newlyTracked: [],
  },
};

const ANALYSIS: AnalystOutput = {
  overallNarrative: "A steady period overall.",
  keyInsights: ["1 keyword ranks in the top 10."],
  notableWins: [{ keyword: "cash for cars perth", note: "Moved from 9 to 7." }],
  notableLosses: [{ keyword: "car removal perth", note: "Dropped from 5 to 20." }],
  recommendedFocusAreas: ["car removal perth"],
};

test("the summary/movements tables render the exact backend numbers, unescaped for numeric values", () => {
  const html = generateReportHtml({ clientName: "Cash For Cars Perth", period: { from: "2026-08-13", to: "2026-08-20" }, analytics: ANALYTICS, analysis: ANALYSIS });

  assert.match(html, /Total keywords<\/th><td>3<\/td>/);
  assert.match(html, /Average rank<\/th><td>15<\/td>/);
  assert.match(html, /Top 10<\/th><td>1<\/td>/);
  assert.match(html, /Not in 100<\/th><td>1<\/td>/);
  assert.match(html, /<td>cash for cars perth<\/td>\s*<td>9<\/td>\s*<td>7<\/td>/);
  assert.match(html, /<td>car removal perth<\/td>\s*<td>5<\/td>\s*<td>20<\/td>/);
});

test("Claude-authored narrative text is HTML-escaped, not rendered as raw markup", () => {
  const maliciousAnalysis: AnalystOutput = {
    ...ANALYSIS,
    overallNarrative: '<script>alert("pwned")</script>',
    keyInsights: ['<img src=x onerror=alert(1)>'],
  };
  const html = generateReportHtml({ clientName: "Cash For Cars Perth", period: { from: "a", to: "b" }, analytics: ANALYTICS, analysis: maliciousAnalysis });

  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<img src=x onerror"));
  assert.ok(html.includes("&lt;img"));
});

test("the numbers table is identical regardless of what the narrative says -- Claude cannot alter the data", () => {
  const optimisticAnalysis: AnalystOutput = { ...ANALYSIS, overallNarrative: "Everything is perfect and ranking #1 everywhere!" };
  const pessimisticAnalysis: AnalystOutput = { ...ANALYSIS, overallNarrative: "A difficult period with major losses." };

  const htmlA = generateReportHtml({ clientName: "X", period: { from: "a", to: "b" }, analytics: ANALYTICS, analysis: optimisticAnalysis });
  const htmlB = generateReportHtml({ clientName: "X", period: { from: "a", to: "b" }, analytics: ANALYTICS, analysis: pessimisticAnalysis });

  const extractSummaryTable = (html: string) => html.split('data-source="claude"')[0]; // everything before the first Claude section
  assert.equal(extractSummaryTable(htmlA), extractSummaryTable(htmlB));
});

test("client name and period are escaped and included in the header", () => {
  const html = generateReportHtml({
    clientName: "Cash & Cars <Perth>",
    period: { from: "2026-08-13", to: "2026-08-20" },
    analytics: ANALYTICS,
    analysis: ANALYSIS,
  });
  assert.ok(html.includes("Cash &amp; Cars &lt;Perth&gt;"));
  assert.ok(html.includes("2026-08-13 to 2026-08-20"));
});
