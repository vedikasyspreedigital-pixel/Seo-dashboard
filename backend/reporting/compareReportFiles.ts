import { normalizeKeyword, parseBaselineRank } from "../baselines/normalizeKeyword.js";
import { computeMatchedPreviousTotals, computeMovements, computeTotals, hasAnyMatch, type RankRow, type RunAnalytics } from "./computeRunAnalytics.js";
import { formatOrdinalDate } from "./formatOrdinalDate.js";
import type { ClientReportPdfInput } from "./generateClientReportPdf.js";
import { RankingsExcelError, clientNameFromFileName, readRankingsExcel, splitLocationKey, type RankingsExcel } from "./readRankingsExcel.js";

// "Compare Reports" tab: two RANKINGS EXCELS picked from the user's own folder,
// each with the date the user says it was checked -> the same comparison and
// the same client PDF the automatic pipeline produces (later date = current,
// earlier = previous). Entirely stateless: nothing is stored, no
// client/run/baseline/report is read or written, no DataForSEO call, no email.

export interface ComparedRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
  /** "Australia|google.com.au" */
  location: string;
}

export interface ComparedFile {
  fileName: string;
  sheetName: string;
  date: string; // ISO, as picked by the user
  dateLabel: string; // "15th September 2026"
  keywordCount: number;
  missingRankCount: number;
}

/** Everything the PDF step needs, returned to the browser and sent back -- the server keeps nothing. */
export interface ReportComparison {
  older: ComparedFile;
  newer: ComparedFile;
  clientName: string;
  clientDomain: string | null;
  currentRows: ComparedRow[];
  previousRows: ComparedRow[];
  /** Things worth a look before sending (blank ranks, skipped rows, different websites). */
  warnings: string[];
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

export interface UploadedRankingsFile {
  buffer: Buffer;
  name: string;
  date: Date | null;
}

/** Join key: the same keyword in two countries is two rows. */
const rowKey = (r: { keyword: string; location: string }) => normalizeKeyword(r.keyword) + "|" + r.location;

function rankRows(rows: ComparedRow[]): RankRow[] {
  return rows.map((r) => ({ keyword: r.keyword, rowUid: rowKey(r), rankValue: r.rankValue, rankDisplay: r.rankDisplay }));
}

/** Same comparison the automatic pipeline uses (computeMovements & co), on plain row lists. */
export function analyticsFromRows(currentRows: ComparedRow[], previousRows: ComparedRow[]): RunAnalytics {
  const current = rankRows(currentRows);
  const previous = rankRows(previousRows);
  const totals = computeTotals(current);
  const movements = computeMovements(current, previous);
  const hasComparison = hasAnyMatch(movements);
  const previousTotals = hasComparison ? computeMatchedPreviousTotals(current, previous) : null;
  return { runId: "compare-reports", previousRunId: null, totals, previousTotals, hasComparison, movements };
}

/** The PDF's location groups, in the newer file's order -- same shape as buildReport.loadRowLocations. */
export function locationsFromRows(currentRows: ComparedRow[], previousRows: ComparedRow[]): NonNullable<ClientReportPdfInput["locations"]> {
  const order: string[] = [];
  const byRowUid: Record<string, string> = {};
  const labels: Record<string, { locationName: string; seDomain: string }> = {};
  for (const r of [...currentRows, ...previousRows]) {
    if (!labels[r.location]) {
      labels[r.location] = splitLocationKey(r.location);
      order.push(r.location);
    }
    byRowUid[rowKey(r)] = r.location;
  }
  return { order, byRowUid, labels };
}

export async function compareRankingFiles(fileA: UploadedRankingsFile, fileB: UploadedRankingsFile): Promise<ReportComparison> {
  for (const f of [fileA, fileB]) {
    if (!f.date) throw new CompareReportsError(`Pick the date the rankings in "${f.name}" were checked.`);
  }
  if (fileA.date!.getTime() === fileB.date!.getTime()) {
    throw new CompareReportsError(`Both files are dated ${formatOrdinalDate(fileA.date!)}. Pick two different dates.`);
  }
  const read = async (f: UploadedRankingsFile) => {
    try {
      return await readRankingsExcel(f.buffer);
    } catch (err) {
      if (err instanceof RankingsExcelError) throw new CompareReportsError(`Couldn't read "${f.name}": ${err.message}`);
      throw err;
    }
  };
  const [a, b] = await Promise.all([read(fileA), read(fileB)]);
  // Later date = current, earlier = previous -- which box each file went in doesn't matter.
  const [olderFile, older, newerFile, newer] =
    fileA.date!.getTime() < fileB.date!.getTime() ? [fileA, a, fileB, b] : [fileB, b, fileA, a];

  const currentRows: ComparedRow[] = newer.rows;
  const previousRows: ComparedRow[] = older.rows;
  const analytics = analyticsFromRows(currentRows, previousRows);
  const previousKeys = new Set(previousRows.map(rowKey));
  const currentKeys = new Set(currentRows.map(rowKey));

  const describe = (f: UploadedRankingsFile, x: RankingsExcel): ComparedFile => ({
    fileName: f.name,
    sheetName: x.sheetName,
    date: f.date!.toISOString(),
    dateLabel: formatOrdinalDate(f.date!),
    keywordCount: x.rows.length,
    missingRankCount: x.rows.filter((r) => r.rankDisplay === null).length,
  });
  const olderInfo = describe(olderFile, older);
  const newerInfo = describe(newerFile, newer);

  const warnings: string[] = [];
  for (const [info, x] of [[newerInfo, newer], [olderInfo, older]] as const) {
    if (info.missingRankCount > 0) {
      warnings.push(`${info.missingRankCount} keyword${info.missingRankCount === 1 ? "" : "s"} in "${info.fileName}" (${info.dateLabel}) ha${info.missingRankCount === 1 ? "s" : "ve"} no rank -- shown as no rank in the report.`);
    }
    if (x.skippedRows.length > 0) {
      const rowsList = x.skippedRows.slice(0, 5).map((s) => s.sourceRowNumber).join(", ");
      warnings.push(`${x.skippedRows.length} row${x.skippedRows.length === 1 ? "" : "s"} in "${info.fileName}" skipped (row ${rowsList}${x.skippedRows.length > 5 ? ", …" : ""}): ${x.skippedRows[0].reason}.`);
    }
  }
  if (newer.clientDomain && older.clientDomain && newer.clientDomain !== older.clientDomain) {
    warnings.push(`The two files are for different websites: ${older.clientDomain} and ${newer.clientDomain}.`);
  }

  return {
    older: olderInfo,
    newer: newerInfo,
    clientName: [newerFile, olderFile].map((f) => clientNameFromFileName(f.name)).find((n) => n !== "Client") ?? "Client",
    clientDomain: newer.clientDomain ?? older.clientDomain ?? null,
    currentRows,
    previousRows,
    warnings,
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

/** Validates the row lists sent back by the browser for the PDF step (they came from compareRankingFiles, but never trust it). */
export function sanitizeComparedRows(raw: unknown, label: string): ComparedRow[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5000) throw new CompareReportsError(`${label}: expected a list of keywords.`);
  return raw.map((r, i) => {
    const row = r as Record<string, unknown>;
    if (!row || typeof row.keyword !== "string" || !row.keyword.trim() || row.keyword.length > 300) throw new CompareReportsError(`${label} row ${i + 1}: invalid keyword.`);
    if (typeof row.location !== "string" || row.location.length > 300) throw new CompareReportsError(`${label} row ${i + 1}: invalid location.`);
    // Re-derive the rank from its display text with the same rules as the readers.
    const display = typeof row.rankDisplay === "string" ? row.rankDisplay : typeof row.rankValue === "number" ? String(row.rankValue) : "";
    const { rankValue, rankDisplay } = parseBaselineRank(display);
    return { keyword: row.keyword.trim(), rankValue, rankDisplay, location: row.location.trim() };
  });
}
