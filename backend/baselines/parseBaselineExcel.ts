import ExcelJS from "exceljs";
import { parseBaselineRank } from "./normalizeKeyword.js";
import { parseDateLabel, pickNewestDateColumn } from "./parseDateColumn.js";

// A lenient parser for an AGENCY'S OWN historical ranking export -- distinct
// from backend/excel/parser.js (parseRankingExcel), which expects this
// app's own fixed processing schema (Keywords/Full URL/URL/.../Status/Ranks/
// Ranking URL). An agency's existing report can look like anything.
//
// Header-row detection tries two strategies, in order:
//  1. A cell literally containing "keyword" (fast path, matches a clean
//     export).
//  2. Falls back to locating the row with the most date-parseable column
//     headers, treating the first non-date column as the keyword column --
//     needed because a real agency export (an Excel version of the exact
//     same report as the PDF this feature was built against) had a
//     genuinely BLANK header cell where "Keyword" would be, with nothing
//     anywhere in the file spelling that word out. The date columns are
//     already a hard requirement for this parser to work at all, so using
//     them to locate the header row too, instead of insisting on a literal
//     label, covers this real-world case without weakening validation --
//     a row with no parseable date columns still isn't accepted as a header.

export interface BaselinePreviewRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

export interface BaselinePreview {
  detectedDates: { label: string; isoDate: string }[];
  baselineDate: string; // ISO -- the auto-selected newest column
  baselineDateLabel: string; // the original header text, for display
  rows: BaselinePreviewRow[];
}

const HEADER_SEARCH_ROWS = 5;

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) {
    return (value.richText as { text: string }[]).map((p) => p.text).join("");
  }
  return String(value).trim();
}

export async function parseBaselineExcel(fileBuffer: Buffer): Promise<BaselinePreview> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's own .d.ts predates this project's @types/node Buffer generic
  // (Buffer<ArrayBufferLike>) -- structurally identical at runtime, just a
  // type-declaration mismatch between the two packages' Buffer typings.
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The uploaded Excel file has no worksheets.");

  let headerRowNumber: number | null = null;
  let keywordColumn: number | null = null;

  // Strategy 1: an explicit "Keyword" label.
  for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SEARCH_ROWS, worksheet.rowCount); rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const col = row.values ? (row.values as unknown[]).findIndex((_, i) => i > 0 && cellText(row.getCell(i)).toLowerCase() === "keyword") : -1;
    if (col > 0) {
      headerRowNumber = rowNumber;
      keywordColumn = col;
      break;
    }
  }

  // Strategy 2: the row with the most date-parseable column headers --
  // its first non-date column is the keyword column, whether or not that
  // cell actually has a label.
  if (headerRowNumber === null) {
    let bestRowNumber: number | null = null;
    let bestDateColumns: number[] = [];
    for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SEARCH_ROWS, worksheet.rowCount); rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const dateCols: number[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (parseDateLabel(cellText(cell))) dateCols.push(colNumber);
      });
      if (dateCols.length >= 2 && dateCols.length > bestDateColumns.length) {
        bestRowNumber = rowNumber;
        bestDateColumns = dateCols;
      }
    }
    if (bestRowNumber !== null) {
      headerRowNumber = bestRowNumber;
      // The keyword column is whichever column immediately precedes the
      // first detected date column -- matches every real layout seen so
      // far (keyword on the left, dates to its right).
      const firstDateColumn = Math.min(...bestDateColumns);
      keywordColumn = firstDateColumn > 1 ? firstDateColumn - 1 : 1;
    }
  }

  if (headerRowNumber === null || keywordColumn === null) {
    throw new Error('Could not find a "Keyword" column, or any date-labeled columns, in the first few rows of this Excel file.');
  }

  const headerRow = worksheet.getRow(headerRowNumber);
  const dateColumns: { column: number; label: string }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber === keywordColumn) return;
    const label = cellText(cell);
    if (label && parseDateLabel(label)) dateColumns.push({ column: colNumber, label });
  });
  if (dateColumns.length === 0) {
    throw new Error('Found a "Keyword" column, but no column headers to its right parse as a date.');
  }

  const newest = pickNewestDateColumn(dateColumns.map((d) => ({ label: d.label, column: d.column })));
  if (!newest) throw new Error("Could not determine the most recent date column.");

  const rows: BaselinePreviewRow[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const keyword = cellText(row.getCell(keywordColumn));
    if (!keyword) continue; // blank/trailing row
    const { rankValue, rankDisplay } = parseBaselineRank(cellText(row.getCell(newest.column.column)));
    rows.push({ keyword, rankValue, rankDisplay });
  }

  return {
    detectedDates: dateColumns.map((d) => ({ label: d.label, isoDate: (parseDateLabel(d.label) as Date).toISOString() })),
    baselineDate: newest.date.toISOString(),
    baselineDateLabel: newest.column.label,
    rows,
  };
}
