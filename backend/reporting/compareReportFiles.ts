import { parseBaselineFile, type BaselinePreview } from "../baselines/parseBaselineFile.js";
import { normalizeKeyword, parseBaselineRank } from "../baselines/normalizeKeyword.js";
import { computeMatchedPreviousTotals, computeMovements, computeTotals, hasAnyMatch, type RankRow, type RunAnalytics } from "./computeRunAnalytics.js";
import { formatOrdinalDate } from "./formatOrdinalDate.js";
import type { ClientReportPdfInput } from "./generateClientReportPdf.js";

// "Compare Reports" tab: two finished report files (Excel or PDF) picked from
// the user's own folder -> the same comparison and the same client PDF the
// automatic pipeline produces. Entirely stateless: nothing is stored, no
// client/run/baseline/report is read or written, no DataForSEO call, no email.
// Reuses the Previous Ranking reader (newest date column of each file, location
// section rows) and the report comparison (computeMovements & co) unchanged.

export interface ComparedRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
  section: string | null;
}

export interface ComparedReport {
  fileName: string;
  date: string; // ISO -- the file's newest ranking-date column
  dateLabel: string; // "1st October 2026"
  keywordCount: number;
}

/** Everything the PDF step needs, returned to the browser and sent back -- the server keeps nothing. */
export interface ReportComparison {
  older: ComparedReport;
  newer: ComparedReport;
  clientName: string;
  clientDomain: string | null;
  /** Newer report's location sections in file order (empty for a single-location report). */
  sections: { name: string; domain: string }[];
  primarySearchDomain: string | null;
  currentRows: ComparedRow[];
  previousRows: ComparedRow[];
  summary: {
    matched: number;
    onlyInNewer: number;
    onlyInOlder: number;
    improved: number;
    declined: number;
    unchanged: number;
  };
}

export class CompareReportsError extends Error {}

/** "Twin Crown - Keyword Ranking Report - 31st August 2026 - 15th September 2026.pdf" -> "Twin Crown". */
export function clientNameFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, "").trim();
  const match = stem.match(/^(.*?)\s*[-–]\s*keyword ranking report\b/i);
  return (match ? match[1] : stem).trim() || "Client";
}

function toRows(preview: BaselinePreview): ComparedRow[] {
  return preview.rows.map((r) => ({ keyword: r.keyword, rankValue: r.rankValue, rankDisplay: r.rankDisplay, section: r.section ?? null }));
}

function rankRows(rows: ComparedRow[]): RankRow[] {
  return rows.map((r) => ({ keyword: r.keyword, rowUid: normalizeKeyword(r.keyword), rankValue: r.rankValue, rankDisplay: r.rankDisplay }));
}

/** Same comparison the automatic pipeline uses against a baseline (compareRunToBaseline), on plain row lists. */
export function analyticsFromRows(currentRows: ComparedRow[], previousRows: ComparedRow[]): RunAnalytics {
  const current = rankRows(currentRows);
  const previous = rankRows(previousRows);
  const totals = computeTotals(current);
  const movements = computeMovements(current, previous);
  const hasComparison = hasAnyMatch(movements);
  const previousTotals = hasComparison ? computeMatchedPreviousTotals(current, previous) : null;
  return { runId: "compare-reports", previousRunId: null, totals, previousTotals, hasComparison, movements };
}

/** The PDF's location groups: rows before the first section are the main location, then each section in file order. */
export function locationsFromRows(
  currentRows: ComparedRow[],
  sections: { name: string; domain: string }[],
  primarySearchDomain: string | null,
): NonNullable<ClientReportPdfInput["locations"]> {
  const MAIN = "__main__";
  const labels: Record<string, { locationName: string; seDomain: string }> = { [MAIN]: { locationName: "", seDomain: primarySearchDomain ?? "" } };
  const order = [MAIN];
  for (const s of sections) {
    if (!labels[s.name]) {
      labels[s.name] = { locationName: s.name, seDomain: s.domain };
      order.push(s.name);
    }
  }
  const byRowUid: Record<string, string> = {};
  for (const r of currentRows) byRowUid[normalizeKeyword(r.keyword)] = r.section && labels[r.section] ? r.section : MAIN;
  // No keyword before the first section: the first section is the main group (header shows its Google).
  if (!currentRows.some((r) => !r.section) && order.length > 1) order.shift();
  return { order, byRowUid, labels };
}

export async function compareReportFiles(fileA: { buffer: Buffer; name: string }, fileB: { buffer: Buffer; name: string }): Promise<ReportComparison> {
  const read = async (f: { buffer: Buffer; name: string }) => {
    try {
      return await parseBaselineFile(f.buffer);
    } catch (err) {
      throw new CompareReportsError(`Couldn't read "${f.name}": ${(err as Error).message}`);
    }
  };
  const [a, b] = await Promise.all([read(fileA), read(fileB)]);
  if (a.rows.length === 0) throw new CompareReportsError(`No keywords found in "${fileA.name}".`);
  if (b.rows.length === 0) throw new CompareReportsError(`No keywords found in "${fileB.name}".`);

  const dateA = new Date(a.baselineDate).getTime();
  const dateB = new Date(b.baselineDate).getTime();
  if (dateA === dateB) {
    throw new CompareReportsError(`Both reports are dated ${formatOrdinalDate(new Date(a.baselineDate))}. Upload two reports from different dates.`);
  }
  // Order is detected from the dates -- it doesn't matter which box each file went in.
  const [older, olderFile, newer, newerFile] = dateA < dateB ? [a, fileA, b, fileB] : [b, fileB, a, fileA];

  let currentRows = toRows(newer);
  const previousRows = toRows(older);
  // A newer report without location sections (e.g. a flat single-table PDF)
  // borrows them from the older report, keyword by keyword, so a
  // multi-location client's comparison still comes out grouped by country.
  let sections = newer.sections ?? [];
  if (sections.length === 0 && (older.sections ?? []).length > 0) {
    const olderSection = new Map(previousRows.map((r) => [normalizeKeyword(r.keyword), r.section]));
    currentRows = currentRows.map((r) => ({ ...r, section: olderSection.get(normalizeKeyword(r.keyword)) ?? null }));
    sections = older.sections ?? [];
  }
  const analytics = analyticsFromRows(currentRows, previousRows);
  const previousKeys = new Set(previousRows.map((r) => normalizeKeyword(r.keyword)));
  const currentKeys = new Set(currentRows.map((r) => normalizeKeyword(r.keyword)));
  const describe = (p: BaselinePreview, f: { name: string }): ComparedReport => ({
    fileName: f.name,
    date: p.baselineDate,
    dateLabel: formatOrdinalDate(new Date(p.baselineDate)),
    keywordCount: p.rows.length,
  });

  return {
    older: describe(older, olderFile),
    newer: describe(newer, newerFile),
    clientName: clientNameFromFileName(newerFile.name),
    clientDomain: newer.clientDomain ?? older.clientDomain ?? null,
    sections,
    primarySearchDomain: newer.primarySearchDomain ?? older.primarySearchDomain ?? null,
    currentRows,
    previousRows,
    summary: {
      matched: [...currentKeys].filter((k) => previousKeys.has(k)).length,
      onlyInNewer: [...currentKeys].filter((k) => !previousKeys.has(k)).length,
      onlyInOlder: [...previousKeys].filter((k) => !currentKeys.has(k)).length,
      improved: analytics.movements.improved.length,
      declined: analytics.movements.declined.length,
      unchanged: analytics.movements.unchanged.length,
    },
  };
}

/** Validates the row lists sent back by the browser for the PDF step (they came from compareReportFiles, but never trust it). */
export function sanitizeComparedRows(raw: unknown, label: string): ComparedRow[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2000) throw new CompareReportsError(`${label}: expected a list of keywords.`);
  return raw.map((r, i) => {
    const row = r as Record<string, unknown>;
    if (!row || typeof row.keyword !== "string" || !row.keyword.trim() || row.keyword.length > 300) throw new CompareReportsError(`${label} row ${i + 1}: invalid keyword.`);
    // Re-derive the rank from its display text with the same rules the reader uses.
    const display = typeof row.rankDisplay === "string" ? row.rankDisplay : typeof row.rankValue === "number" ? String(row.rankValue) : "";
    const { rankValue, rankDisplay } = parseBaselineRank(display);
    const section = typeof row.section === "string" && row.section.length <= 200 ? row.section : null;
    return { keyword: row.keyword.trim(), rankValue, rankDisplay, section };
  });
}
