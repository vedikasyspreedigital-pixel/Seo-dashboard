// The client-facing SEO PDF -- deliberately just two parts: a summary of
// deterministic totals, and one keyword ranking table. No narrative, no
// commentary, no charts. Every number here comes straight from
// computeRunAnalytics's already-tested output (RunAnalytics); nothing in
// this file calls Claude or accepts Claude-authored input.
//
// Rendered via Playwright printing plain HTML to PDF (same technique as the
// rest of this app's PDF work) rather than a PDF-drawing library -- lets
// the table use a normal <thead> and Chromium's print engine repeats it on
// every page automatically when the table spans multiple A4 pages.

import { chromium } from "playwright";
import type { RunAnalytics } from "./computeRunAnalytics.js";

export interface ClientReportPdfInput {
  clientName: string;
  currentRunDate: Date;
  previousRunDate: Date | null;
  analytics: RunAnalytics;
}

type MovementKind = "improved" | "dropped" | "unchanged" | "new" | "lost";

interface TableRow {
  keyword: string;
  previousRankLabel: string;
  currentRankLabel: string;
  movementLabel: string;
  kind: MovementKind;
}

const MOVEMENT_COLOR: Record<MovementKind, string> = {
  improved: "#1a7f37",
  new: "#1a7f37",
  dropped: "#c0362c",
  lost: "#c0362c",
  unchanged: "#6b7280",
};

const RANK_DISPLAY = (rank: number | null): string => (rank === null ? "Not in 100" : String(rank));

/**
 * Human-readable overall movement, never raw signed arithmetic. Lower rank
 * number is better, so the delta is previous-minus-current: positive means
 * the average rank improved (moved toward #1) by that many positions.
 */
export function describeOverallRankingChange(previousAverageRank: number | null, currentAverageRank: number | null): string {
  if (previousAverageRank === null || currentAverageRank === null) return "No change";
  const delta = round1(previousAverageRank - currentAverageRank);
  if (delta > 0) return `↑ Improved by ${delta} position${delta === 1 ? "" : "s"}`;
  if (delta < 0) return `↓ Declined by ${Math.abs(delta)} position${Math.abs(delta) === 1 ? "" : "s"}`;
  return "No change";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Partitions RunAnalytics.movements into the table rows and the Ranking
 * Performance Summary counts. Every current-run row falls into exactly ONE
 * bucket, and "improved from no previous rank" / "newlyTracked" are both
 * presented as "New" in the table (both mean the keyword had no previous
 * rank and now has one) but are summed as one non-overlapping
 * "enteredTop100" count. Declined is similarly split into "still ranked but
 * worse" (dropped) vs "fully out of the top 100" (droppedOutOfTop100) -- the
 * table's per-row "↓ Lost" label already distinguished these, this just also
 * sums them separately for the summary.
 */
export function buildRowsAndSummary(analytics: RunAnalytics) {
  const rows: TableRow[] = [];
  let improvedCount = 0;
  let enteredTop100Count = 0;
  let droppedCount = 0;
  let droppedOutOfTop100Count = 0;

  for (const m of analytics.movements.improved) {
    if (m.previousRank === null) {
      enteredTop100Count++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new" });
    } else {
      improvedCount++;
      const delta = m.delta ?? 0;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: `↑ +${delta}`, kind: "improved" });
    }
  }

  for (const m of analytics.movements.declined) {
    if (m.currentRank === null) {
      droppedOutOfTop100Count++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↓ Lost", kind: "lost" });
    } else {
      droppedCount++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: `↓ ${m.delta ?? 0}`, kind: "dropped" });
    }
  }

  for (const m of analytics.movements.unchanged) {
    rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "→ 0", kind: "unchanged" });
  }

  for (const m of analytics.movements.newlyTracked) {
    enteredTop100Count++;
    rows.push({ keyword: m.keyword, previousRankLabel: "Not in 100", currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new" });
  }

  rows.sort((a, b) => a.keyword.localeCompare(b.keyword));

  return {
    rows,
    summary: {
      totalKeywords: analytics.totals.totalKeywords,
      improved: improvedCount,
      dropped: droppedCount,
      unchanged: analytics.movements.unchanged.length,
      enteredTop100: enteredTop100Count,
      droppedOutOfTop100: droppedOutOfTop100Count,
      previousAverageRank: analytics.previousTotals?.averageRank ?? null,
      currentAverageRank: analytics.totals.averageRank,
      overallRankingChange: describeOverallRankingChange(analytics.previousTotals?.averageRank ?? null, analytics.totals.averageRank),
    },
  };
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml(input: ClientReportPdfInput): string {
  const { rows, summary } = buildRowsAndSummary(input.analytics);

  const changeColor = summary.overallRankingChange.startsWith("↑")
    ? MOVEMENT_COLOR.improved
    : summary.overallRankingChange.startsWith("↓")
      ? MOVEMENT_COLOR.dropped
      : MOVEMENT_COLOR.unchanged;

  const summaryCards =
    [
      { label: "Total Keywords Tracked", value: String(summary.totalKeywords), color: "#111827" },
      { label: "Keywords Improved ↑", value: String(summary.improved), color: MOVEMENT_COLOR.improved },
      { label: "Keywords Dropped ↓", value: String(summary.dropped), color: MOVEMENT_COLOR.dropped },
      { label: "Keywords Unchanged", value: String(summary.unchanged), color: MOVEMENT_COLOR.unchanged },
      { label: "Entered Top 100", value: String(summary.enteredTop100), color: MOVEMENT_COLOR.improved },
      { label: "Dropped Out of Top 100", value: String(summary.droppedOutOfTop100), color: MOVEMENT_COLOR.dropped },
      { label: "Previous Average Rank", value: summary.previousAverageRank === null ? "—" : String(summary.previousAverageRank), color: "#111827" },
      { label: "Current Average Rank", value: summary.currentAverageRank === null ? "—" : String(summary.currentAverageRank), color: "#111827" },
    ]
      .map(
        (c) => `<div class="stat"><p class="stat-label">${escapeHtml(c.label)}</p><p class="stat-value" style="color:${c.color}">${escapeHtml(c.value)}</p></div>`,
      )
      .join("") +
    `<div class="stat stat-wide"><p class="stat-label">Overall Ranking Change</p><p class="stat-value stat-value-text" style="color:${changeColor}">${escapeHtml(summary.overallRankingChange)}</p></div>`;

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.keyword)}</td>
        <td class="num">${escapeHtml(r.previousRankLabel)}</td>
        <td class="num">${escapeHtml(r.currentRankLabel)}</td>
        <td class="num" style="color:${MOVEMENT_COLOR[r.kind]}; font-weight:600;">${escapeHtml(r.movementLabel)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; }
  h1 { font-size: 18px; letter-spacing: 0.04em; margin: 0 0 14px; }
  .meta { font-size: 11px; color: #4b5563; line-height: 1.6; margin-bottom: 18px; }
  .meta b { color: #111827; }
  .summary-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; margin: 0 0 10px; color: #111827; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 22px; }
  .stat { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
  .stat-wide { grid-column: 1 / -1; }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin: 0 0 4px; }
  .stat-value { font-size: 20px; font-weight: 700; margin: 0; }
  .stat-value-text { font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { text-align: left; background: #f3f4f6; padding: 7px 10px; border-bottom: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
  td { padding: 6px 10px; border-bottom: 1px solid #eceef1; }
  td.num, th.num { text-align: right; }
  tr:nth-child(even) td { background: #fafafa; }
</style>
</head>
<body>
  <h1>SEO PERFORMANCE REPORT</h1>
  <p class="meta">
    <b>Client:</b> ${escapeHtml(input.clientName)}<br>
    <b>Current Report Date:</b> ${formatDate(input.currentRunDate)}<br>
    <b>Compared With:</b> ${input.previousRunDate ? formatDate(input.previousRunDate) : "No prior run"}
  </p>

  <p class="summary-title">Ranking Performance Summary</p>
  <div class="stats">${summaryCards}</div>

  <table>
    <thead>
      <tr>
        <th>Keyword</th>
        <th class="num">Previous Rank</th>
        <th class="num">Current Rank</th>
        <th class="num">Improvement / Dropped</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
}

export async function generateClientReportPdf(input: ClientReportPdfInput): Promise<Buffer> {
  const html = buildHtml(input);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}
