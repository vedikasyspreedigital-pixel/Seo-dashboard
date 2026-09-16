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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunAnalytics } from "./computeRunAnalytics.js";
import { formatOrdinalDate } from "./formatOrdinalDate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Embedded as a data URI (not a file:// src) so the PDF renders identically
// regardless of the container's working directory -- Playwright's
// page.setContent has no base URL to resolve a relative/absolute file path
// against.
const SYSPREE_LOGO_DATA_URI = `data:image/png;base64,${readFileSync(path.join(__dirname, "assets/syspree-logo.png")).toString("base64")}`;

export interface ClientReportPdfInput {
  clientName: string;
  /** The client's website domain, shown in the header -- purely informational, never used for keyword matching. */
  clientDomain?: string | null;
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
  currentRank: number | null;
}

const RANK_DISPLAY = (rank: number | null): string => (rank === null ? "Not in 100" : String(rank));

const MOVEMENT_COLOR: Record<MovementKind, string> = {
  improved: "#1a7f37",
  new: "#1a7f37",
  dropped: "#c0362c",
  lost: "#c0362c",
  unchanged: "#6b7280",
};

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
  if (!analytics.hasComparison) return buildCurrentOnlyRowsAndSummary(analytics);

  const rows: TableRow[] = [];
  let improvedCount = 0;
  let enteredTop100Count = 0;
  let droppedCount = 0;
  let droppedOutOfTop100Count = 0;

  for (const m of analytics.movements.improved) {
    if (m.previousRank === null) {
      enteredTop100Count++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new", currentRank: m.currentRank });
    } else {
      improvedCount++;
      const delta = m.delta ?? 0;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: `↑ +${delta}`, kind: "improved", currentRank: m.currentRank });
    }
  }

  for (const m of analytics.movements.declined) {
    if (m.currentRank === null) {
      droppedOutOfTop100Count++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↓ Lost", kind: "lost", currentRank: m.currentRank });
    } else {
      droppedCount++;
      rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: `↓ ${m.delta ?? 0}`, kind: "dropped", currentRank: m.currentRank });
    }
  }

  for (const m of analytics.movements.unchanged) {
    rows.push({ keyword: m.keyword, previousRankLabel: RANK_DISPLAY(m.previousRank), currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "→ 0", kind: "unchanged", currentRank: m.currentRank });
  }

  for (const m of analytics.movements.newlyTracked) {
    enteredTop100Count++;
    rows.push({ keyword: m.keyword, previousRankLabel: "Not in 100", currentRankLabel: RANK_DISPLAY(m.currentRank), movementLabel: "↑ New", kind: "new", currentRank: m.currentRank });
  }

  // Ranked keywords first (rank ascending, 1..100), then a clearly separated
  // "Not in Top 100" tail (alphabetical) -- never interleaved. Previously
  // this was a single alphabetical sort across everything, which mixed
  // "Not in 100" rows in among ranked ones in whatever order their keyword
  // happened to fall. Kept as one flat, already-grouped array (rather than
  // two separate arrays) so `rows.find(...)`-style lookups elsewhere don't
  // need to know about the split -- buildHtml locates the boundary itself
  // (first row with currentRank === null) to render the section heading.
  const ranked = rows.filter((r) => r.currentRank !== null).sort((a, b) => (a.currentRank as number) - (b.currentRank as number));
  const notInTop100 = rows.filter((r) => r.currentRank === null).sort((a, b) => a.keyword.localeCompare(b.keyword));

  return {
    rows: [...ranked, ...notInTop100],
    summary: {
      hasComparison: true as const,
      totalKeywords: analytics.totals.totalKeywords,
      improved: improvedCount,
      dropped: droppedCount,
      unchanged: analytics.movements.unchanged.length,
      enteredTop100: enteredTop100Count,
      droppedOutOfTop100: droppedOutOfTop100Count,
      previousAverageRank: analytics.previousTotals?.averageRank ?? null,
      currentAverageRank: analytics.totals.averageRank,
      overallRankingChange: describeOverallRankingChange(analytics.previousTotals?.averageRank ?? null, analytics.totals.averageRank),
      top3Count: analytics.totals.top3Count,
      top10Count: analytics.totals.top10Count,
      notIn100Count: analytics.totals.notIn100Count,
    },
  };
}

/**
 * A brand-new client's first-ever run: real current-ranking data, but
 * nothing to compare it against (no prior run, no imported baseline). Every
 * keyword still shows its current rank -- this is what buildRowsAndSummary
 * silently produced as an EMPTY report before, and what movements-based
 * comparison language would misrepresent as "everything just entered the
 * top 100" if reused as-is (there was no previous state to have entered
 * from). Renders a plain current-standing table/summary instead.
 */
function buildCurrentOnlyRowsAndSummary(analytics: RunAnalytics) {
  const rows: TableRow[] = analytics.movements.newlyTracked.map((m) => ({
    keyword: m.keyword,
    previousRankLabel: "—",
    currentRankLabel: RANK_DISPLAY(m.currentRank),
    movementLabel: "—",
    kind: "unchanged",
    currentRank: m.currentRank,
  }));

  const ranked = rows.filter((r) => r.currentRank !== null).sort((a, b) => (a.currentRank as number) - (b.currentRank as number));
  const notInTop100 = rows.filter((r) => r.currentRank === null).sort((a, b) => a.keyword.localeCompare(b.keyword));

  return {
    rows: [...ranked, ...notInTop100],
    summary: {
      hasComparison: false as const,
      totalKeywords: analytics.totals.totalKeywords,
      improved: 0,
      dropped: 0,
      unchanged: 0,
      enteredTop100: 0,
      droppedOutOfTop100: 0,
      previousAverageRank: null,
      currentAverageRank: analytics.totals.averageRank,
      overallRankingChange: "No change",
      top3Count: analytics.totals.top3Count,
      top10Count: analytics.totals.top10Count,
      notIn100Count: analytics.totals.notIn100Count,
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Matches the reference SySpree client report layout: a gray branded
 * banner (logo left, title/domain/date right), then a single keyword
 * table with two orange header rows. Current rank is shown before
 * previous rank (matching the reference's own column order), with the
 * real dates as column headers rather than generic "Current"/"Previous"
 * labels, plus a color-coded Improved/Dropped column.
 */
function buildHtml(input: ClientReportPdfInput): string {
  const { rows } = buildRowsAndSummary(input.analytics);

  const currentDateLabel = formatOrdinalDate(input.currentRunDate);
  const previousDateLabel = input.previousRunDate ? formatOrdinalDate(input.previousRunDate) : "No prior run";

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.keyword)}</td>
        <td class="num">${escapeHtml(r.currentRankLabel)}</td>
        <td class="num">${escapeHtml(r.previousRankLabel)}</td>
        <td class="num" style="color:${MOVEMENT_COLOR[r.kind]}; font-weight:600;">${escapeHtml(r.movementLabel)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 14mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; }
  .brand-header { display: flex; align-items: center; justify-content: space-between; background: #58595b; color: #ffffff; padding: 10px 18px; margin-bottom: 18px; }
  .brand-logo-chip { background: #ffffff; padding: 6px 14px; display: flex; align-items: center; }
  .brand-logo-chip img { display: block; height: 34px; width: auto; }
  .brand-meta { text-align: right; line-height: 1.5; }
  .brand-meta .title { font-size: 13px; font-weight: 700; }
  .brand-meta .line { font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { text-align: left; background: #e8791a; color: #ffffff; padding: 7px 10px; font-size: 10.5px; font-weight: 700; border: 1px solid #ffffff; }
  th.label-row { background: #e8791a; }
  td { padding: 6px 10px; border-bottom: 1px solid #eceef1; }
  td.num, th.num { text-align: center; }
  tr:nth-child(even) td { background: #fafafa; }
</style>
</head>
<body>
  <div class="brand-header">
    <div class="brand-logo-chip"><img src="${SYSPREE_LOGO_DATA_URI}" alt="SySpree"></div>
    <div class="brand-meta">
      <div class="title">Client Keyword Ranking Report</div>
      ${input.clientDomain ? `<div class="line">${escapeHtml(input.clientDomain)}</div>` : ""}
      <div class="line">${currentDateLabel}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="label-row">Current Ranking Status:</th>
        <th class="num label-row">Google.ae</th>
        <th class="num label-row">Google.ae</th>
        <th class="label-row">&nbsp;</th>
      </tr>
      <tr>
        <th>Keyword</th>
        <th class="num">${currentDateLabel}</th>
        <th class="num">${previousDateLabel}</th>
        <th class="num">Improved / Dropped</th>
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
