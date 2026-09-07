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
 * Partitions RunAnalytics.movements into the table rows and summary counts.
 * Every current-run row falls into exactly ONE bucket (improved/declined/
 * unchanged/newlyTracked are already mutually exclusive in
 * computeRunAnalytics), except that "improved from no previous rank" and
 * "newlyTracked" are both presented as "New" here -- both mean the keyword
 * had no previous rank and now has one, they just differ in whether the row
 * existed in the previous run's Excel at all. Splitting Improved this way
 * keeps the 5 summary counts non-overlapping and summing to Total Keywords.
 */
export function buildRowsAndSummary(analytics: RunAnalytics) {
  const rows: TableRow[] = [];
  let improvedCount = 0;
  let newlyRankedCount = 0;

  for (const m of analytics.movements.improved) {
    if (m.previousRank === null) {
      newlyRankedCount++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new" });
    } else {
      improvedCount++;
      const delta = m.delta ?? 0;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: `↑ +${delta}`, kind: "improved" });
    }
  }

  for (const m of analytics.movements.declined) {
    const label = m.currentRank === null ? "↓ Lost" : `↓ ${m.delta ?? 0}`;
    rows.push({
      keyword: m.keyword,
      previousRankLabel: RANK_DISPLAY(m.previousRank),
      currentRankLabel: RANK_DISPLAY(m.currentRank),
      movementLabel: label,
      kind: m.currentRank === null ? "lost" : "dropped",
    });
  }

  for (const m of analytics.movements.unchanged) {
    rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "→ 0", kind: "unchanged" });
  }

  for (const m of analytics.movements.newlyTracked) {
    newlyRankedCount++;
    rows.push({ keyword: m.keyword, previousRankLabel: "Not in 100", currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new" });
  }

  rows.sort((a, b) => a.keyword.localeCompare(b.keyword));

  return {
    rows,
    summary: {
      totalKeywords: analytics.totals.totalKeywords,
      improved: improvedCount,
      dropped: analytics.movements.declined.length,
      unchanged: analytics.movements.unchanged.length,
      newlyRanked: newlyRankedCount,
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

  const summaryCards = [
    { label: "Total Keywords", value: summary.totalKeywords, color: "#111827" },
    { label: "Improved", value: summary.improved, color: MOVEMENT_COLOR.improved },
    { label: "Dropped", value: summary.dropped, color: MOVEMENT_COLOR.dropped },
    { label: "Unchanged", value: summary.unchanged, color: MOVEMENT_COLOR.unchanged },
    { label: "Newly Ranked", value: summary.newlyRanked, color: MOVEMENT_COLOR.new },
  ]
    .map(
      (c) => `<div class="stat"><p class="stat-label">${escapeHtml(c.label)}</p><p class="stat-value" style="color:${c.color}">${c.value}</p></div>`,
    )
    .join("");

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
  .stats { display: flex; gap: 10px; margin-bottom: 22px; }
  .stat { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin: 0 0 4px; }
  .stat-value { font-size: 20px; font-weight: 700; margin: 0; }
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
