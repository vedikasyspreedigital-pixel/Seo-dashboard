import type { AnalystOutput } from "./reportAnalyst.js";
import type { RunAnalytics } from "./computeRunAnalytics.js";

// Deterministic report rendering -- pure code, no Claude call here. Every
// number/table comes straight from RunAnalytics; Claude's AnalystOutput
// only ever fills narrative text, which is HTML-escaped before insertion
// since it's model-generated content being embedded in a document.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMovementRows(entries: { keyword: string; previousRank: number | null; currentRank: number | null }[]): string {
  if (entries.length === 0) return `<tr><td colspan="3">None</td></tr>`;
  return entries
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.keyword)}</td>
        <td>${e.previousRank ?? "Not in 100"}</td>
        <td>${e.currentRank ?? "Not in 100"}</td>
      </tr>`,
    )
    .join("");
}

export function generateReportHtml({
  clientName,
  period,
  analytics,
  analysis,
}: {
  clientName: string;
  period: { from: string; to: string };
  analytics: RunAnalytics;
  analysis: AnalystOutput;
}): string {
  const { totals, movements } = analytics;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(clientName)} Ranking Report</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 24px;
      background: #f7f8f5;
      color: #1a1d16;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    header, section {
      max-width: 760px;
      margin: 0 auto 24px;
    }
    header {
      padding-bottom: 20px;
      border-bottom: 3px solid #a3e635;
    }
    header h1 {
      margin: 0 0 6px;
      font-size: 26px;
      font-weight: 700;
      color: #14170f;
    }
    header p {
      margin: 0;
      color: #6b7062;
      font-size: 14px;
    }
    section {
      padding: 20px 24px;
      background: #ffffff;
      border: 1px solid #e4e6dd;
      border-radius: 10px;
    }
    /* Claude-authored sections get a subtle distinct background and an
       "AI" marker -- purely visual (CSS only, no markup change), so the
       reader can always tell narrative text apart from backend numbers,
       matching the same convention used in the dashboard UI. */
    section[data-source="claude"] {
      background: #fbfaf5;
      border-color: #ece7d6;
    }
    section h2 {
      margin: 0 0 14px;
      font-size: 16px;
      font-weight: 700;
      color: #14170f;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    section[data-source="claude"] h2::after {
      content: "AI";
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #6d3fd6;
      background: #efe7fd;
      border-radius: 999px;
      padding: 2px 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 9px 12px;
      border-bottom: 1px solid #edeee7;
    }
    table tr:last-child th, table tr:last-child td {
      border-bottom: none;
    }
    th {
      color: #565b4c;
      font-weight: 600;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin-bottom: 6px;
    }
    li:last-child {
      margin-bottom: 0;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(clientName)} &mdash; Ranking Report</h1>
    <p>${escapeHtml(period.from)} to ${escapeHtml(period.to)}</p>
  </header>

  <section data-source="backend">
    <h2>Summary</h2>
    <table>
      <tr><th>Total keywords</th><td>${totals.totalKeywords}</td></tr>
      <tr><th>Average rank</th><td>${totals.averageRank ?? "N/A"}</td></tr>
      <tr><th>Top 3</th><td>${totals.top3Count}</td></tr>
      <tr><th>Top 10</th><td>${totals.top10Count}</td></tr>
      <tr><th>Not in 100</th><td>${totals.notIn100Count}</td></tr>
    </table>
  </section>

  <section data-source="claude">
    <h2>Analyst overview</h2>
    <p>${escapeHtml(analysis.overallNarrative)}</p>
    <ul>${analysis.keyInsights.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
  </section>

  <section data-source="backend">
    <h2>Improved keywords</h2>
    <table><tr><th>Keyword</th><th>Previous</th><th>Current</th></tr>${renderMovementRows(movements.improved)}</table>
  </section>

  <section data-source="backend">
    <h2>Declined keywords</h2>
    <table><tr><th>Keyword</th><th>Previous</th><th>Current</th></tr>${renderMovementRows(movements.declined)}</table>
  </section>

  <section data-source="claude">
    <h2>Notable wins</h2>
    <ul>${analysis.notableWins.map((w) => `<li><strong>${escapeHtml(w.keyword)}</strong>: ${escapeHtml(w.note)}</li>`).join("")}</ul>

    <h2>Notable losses</h2>
    <ul>${analysis.notableLosses.map((l) => `<li><strong>${escapeHtml(l.keyword)}</strong>: ${escapeHtml(l.note)}</li>`).join("")}</ul>

    <h2>Recommended focus areas</h2>
    <ul>${analysis.recommendedFocusAreas.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
  </section>
</body>
</html>`;
}
