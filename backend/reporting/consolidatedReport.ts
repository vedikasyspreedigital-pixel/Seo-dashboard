import ExcelJS from "exceljs";
import { prisma } from "../db/client.js";
import { parseDateLabel } from "../baselines/parseDateColumn.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";
import { formatOrdinalDate } from "./formatOrdinalDate.js";

/**
 * "Consolidated report" (2026-11-10). Some clients (AKT, Vastrado) don't get the 2-date PDF: they get ONE Excel
 * with every past ranking date as a column, newest first ("<Client> - Consolidated Keyword Ranking Report.xlsx").
 * The team made it by hand, adding a column each time.
 *
 * The dashboard keeps the client's last consolidated file (ConsolidatedHistory -- uploaded once by the team,
 * then replaced by each one sent from here) and builds the next one FROM THAT FILE: the new date column goes in
 * front of the old ones and the rows are re-sorted by the new ranks. Everything else -- title rows, colours,
 * column widths, extra columns like "Avg Monthly Searches" -- is the team's own layout, untouched.
 *
 * Keyword rows follow THIS run: a keyword new to the run is added (no history yet); a keyword the run no longer
 * tracks is left out of the report (listed in `dropped`, so the team sees it before sending).
 */

export interface ConsolidatedLayout {
  worksheet: ExcelJS.Worksheet;
  /** The row with "Keyword" in column A and the date headers. */
  headerRow: number;
  /** Date columns in sheet order (newest first in the team's files), 1-based. */
  dateColumns: { col: number; label: string; date: Date }[];
  /** First and last keyword rows (a contiguous block under the header). */
  firstDataRow: number;
  lastDataRow: number;
  keywords: string[];
  newestDate: Date;
}

export class ConsolidatedFileError extends Error {}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("").trim();
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    if (typeof o.text === "string") return o.text.trim();
    if (v instanceof Date) return v.toISOString();
    return "";
  }
  return String(v).trim();
}

/** Finds the keyword table in a consolidated report: the "Keyword(s)" header row and its date columns. */
export function findConsolidatedLayout(workbook: ExcelJS.Workbook): ConsolidatedLayout {
  for (const worksheet of workbook.worksheets) {
    const maxHeader = Math.min(worksheet.rowCount, 20);
    for (let r = 1; r <= maxHeader; r++) {
      const row = worksheet.getRow(r);
      if (!/^keywords?$/i.test(cellText(row.getCell(1)))) continue;
      const dateColumns: ConsolidatedLayout["dateColumns"] = [];
      for (let c = 2; c <= worksheet.columnCount; c++) {
        const label = cellText(row.getCell(c));
        const date = label ? parseDateLabel(label) : null;
        if (date) dateColumns.push({ col: c, label, date });
      }
      if (dateColumns.length === 0) continue;
      const keywords: string[] = [];
      let last = r;
      for (let rr = r + 1; rr <= worksheet.rowCount; rr++) {
        const k = cellText(worksheet.getRow(rr).getCell(1));
        if (!k) break;
        keywords.push(k);
        last = rr;
      }
      if (keywords.length === 0) continue;
      const newestDate = new Date(Math.max(...dateColumns.map((d) => d.date.getTime())));
      return { worksheet, headerRow: r, dateColumns, firstDataRow: r + 1, lastDataRow: last, keywords, newestDate };
    }
  }
  throw new ConsolidatedFileError(
    'This doesn\'t look like a consolidated ranking report: no "Keyword" header with date columns (like "30th Oct 26") was found.',
  );
}

export async function readConsolidatedFile(buffer: Buffer): Promise<{ workbook: ExcelJS.Workbook; layout: ConsolidatedLayout }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ConsolidatedFileError("This file couldn't be opened as an Excel (.xlsx) file.");
  }
  return { workbook, layout: findConsolidatedLayout(workbook) };
}

/** Summary stored next to the file and shown in Client Management. */
export async function describeConsolidatedFile(buffer: Buffer) {
  const { layout } = await readConsolidatedFile(buffer);
  return {
    newestDate: layout.newestDate,
    newestLabel: layout.dateColumns.find((d) => d.date.getTime() === layout.newestDate.getTime())!.label,
    dateColumns: layout.dateColumns.length,
    keywordCount: layout.keywords.length,
  };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** The new column's header, in the same style as the file's newest one: "03rd Nov 26", or "3rd November 2026". */
export function columnLabel(date: Date, styleOf: string): string {
  const day = date.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  if (/\b\d{4}\s*$/.test(styleOf)) return formatOrdinalDate(date);
  return `${String(day).padStart(2, "0")}${suffix} ${SHORT_MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear()).slice(2)}`;
}

export interface NewColumnRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

export interface ConsolidatedBuildResult {
  buffer: Buffer;
  newColumnLabel: string;
  /** Keywords in the history file this run doesn't track -- left out of the report. */
  dropped: string[];
  /** Keywords in this run with no history yet -- added at their rank, older columns empty. */
  added: string[];
  dateColumns: number;
  keywordCount: number;
}

function rankCell(row: NewColumnRow | undefined): string | number {
  if (!row) return "Not in 100";
  if (row.rankValue !== null && row.rankValue !== undefined) return row.rankValue;
  const display = row.rankDisplay?.trim();
  return display && !/^\d+$/.test(display) ? display : "Not in 100";
}

function copyStyle(from: ExcelJS.Cell, to: ExcelJS.Cell) {
  to.style = JSON.parse(JSON.stringify(from.style ?? {}));
}

/** Range "A1:F1" -> numbers; ExcelJS keeps merges as strings. */
function parseRange(range: string) {
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) return null;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { top: Number(m[2]), left: col(m[1]), bottom: Number(m[4]), right: col(m[3]) };
}

/**
 * The next consolidated report: `history` (the client's last consolidated file) with a new date column in
 * front of the old ones, holding `rows` (this report's ranks), rows sorted by the new rank.
 */
export async function buildConsolidatedReport(history: Buffer, input: { reportDate: Date; rows: NewColumnRow[] }): Promise<ConsolidatedBuildResult> {
  const { workbook, layout } = await readConsolidatedFile(history);
  const ws = layout.worksheet;
  const insertAt = Math.min(...layout.dateColumns.map((d) => d.col));
  const newestLabel = layout.dateColumns.find((d) => d.date.getTime() === layout.newestDate.getTime())!.label;
  const label = columnLabel(input.reportDate, newestLabel);
  const lastCol = ws.columnCount;

  // Merged title rows ("Client Keyword Ranking Report", "Current Ranking Status:") must stretch over the new column.
  const merges: string[] = [...(((ws.model as unknown as { merges?: string[] }).merges) ?? [])];
  for (const m of merges) ws.unMergeCells(m);

  // Every row's cells as they are now (values + styles), so rows can be rewritten in the new order.
  type Snap = { value: ExcelJS.CellValue; style: Partial<ExcelJS.Style> };
  const snapRow = (r: number): Snap[] => {
    const out: Snap[] = [];
    for (let c = 1; c <= lastCol; c++) {
      const cell = ws.getRow(r).getCell(c);
      out.push({ value: cell.value, style: JSON.parse(JSON.stringify(cell.style ?? {})) });
    }
    return out;
  };

  const runByKey = new Map<string, NewColumnRow>();
  for (const row of input.rows) if (!runByKey.has(normalizeKeyword(row.keyword))) runByKey.set(normalizeKeyword(row.keyword), row);

  // History rows, by keyword (first one wins for a duplicated keyword; the duplicate is kept as its own row).
  const historyRows: { key: string; keyword: string; cells: Snap[] }[] = [];
  for (let r = layout.firstDataRow; r <= layout.lastDataRow; r++) {
    const keyword = cellText(ws.getRow(r).getCell(1));
    historyRows.push({ key: normalizeKeyword(keyword), keyword, cells: snapRow(r) });
  }
  const styleRows = historyRows.map((h) => h.cells.map((c) => c.style)); // positional styles stay with the row position
  const dropped = historyRows.filter((h) => !runByKey.has(h.key)).map((h) => h.keyword);
  const kept = historyRows.filter((h) => runByKey.has(h.key));
  const inHistory = new Set(historyRows.map((h) => h.key));
  const added = input.rows.filter((r, i, all) => !inHistory.has(normalizeKeyword(r.keyword)) && all.findIndex((x) => normalizeKeyword(x.keyword) === normalizeKeyword(r.keyword)) === i);

  // New rows: [keyword, extras..., NEW, old dates...]. Sorted by the new rank; "Not in 100" keeps file order, after the ranked ones.
  type Out = { cells: (ExcelJS.CellValue | undefined)[]; rank: number; order: number };
  const outRows: Out[] = [];
  kept.forEach((h, i) => {
    const run = runByKey.get(h.key);
    const cells: (ExcelJS.CellValue | undefined)[] = h.cells.map((c) => c.value);
    cells.splice(insertAt - 1, 0, rankCell(run));
    outRows.push({ cells, rank: run?.rankValue ?? Number.POSITIVE_INFINITY, order: i });
  });
  added.forEach((r, i) => {
    const cells: (ExcelJS.CellValue | undefined)[] = new Array(lastCol + 1).fill(null);
    cells[0] = r.keyword;
    cells[insertAt - 1] = rankCell(r);
    outRows.push({ cells, rank: r.rankValue ?? Number.POSITIVE_INFINITY, order: kept.length + i });
  });
  outRows.sort((a, b) => a.rank - b.rank || a.order - b.order);

  // Insert the column (shifts every row's cells and the column widths right).
  ws.spliceColumns(insertAt, 0, []);
  const oldNewest = ws.getColumn(insertAt + 1);
  ws.getColumn(insertAt).width = oldNewest.width;

  // Rows above the keyword rows (title, "Current Ranking Status:", header): style the new cell like its right-hand neighbour.
  for (let r = 1; r <= layout.headerRow; r++) copyStyle(ws.getRow(r).getCell(insertAt + 1), ws.getRow(r).getCell(insertAt));
  ws.getRow(layout.headerRow).getCell(insertAt).value = label;

  // Keyword rows rewritten in the new order; each position keeps its own style (banding, borders).
  const width = lastCol + 1;
  const lastStyles = styleRows[styleRows.length - 1];
  const totalRows = outRows.length;
  for (let i = 0; i < Math.max(totalRows, historyRows.length); i++) {
    const r = layout.firstDataRow + i;
    const row = ws.getRow(r);
    const base = styleRows[Math.min(i, styleRows.length - 1)] ?? lastStyles;
    const styles = [...base];
    styles.splice(insertAt - 1, 0, base[insertAt - 1] ?? base[base.length - 1]); // new cell styled like the old newest date
    for (let c = 1; c <= width; c++) {
      const cell = row.getCell(c);
      if (i < totalRows) {
        cell.value = (outRows[i].cells[c - 1] ?? null) as ExcelJS.CellValue;
        cell.style = JSON.parse(JSON.stringify(styles[c - 1] ?? {}));
      } else {
        cell.value = null; // a dropped keyword's old row
        cell.style = {};
      }
    }
    if (i >= totalRows) row.height = undefined as unknown as number;
  }

  for (const m of merges) {
    const p = parseRange(m);
    if (!p) continue;
    const shift = (col: number) => (col >= insertAt ? col + 1 : col);
    const left = shift(p.left);
    const right = p.right >= insertAt - 1 && p.left < insertAt ? p.right + 1 : shift(p.right);
    if (left === right && p.top === p.bottom) continue;
    ws.mergeCells(p.top, left, p.bottom, right);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, newColumnLabel: label, dropped, added: added.map((a) => a.keyword), dateColumns: layout.dateColumns.length + 1, keywordCount: totalRows };
}

/** "<Client> - Consolidated Keyword Ranking Report.xlsx" -- the name the team already uses. */
export function consolidatedFilename(clientName: string): string {
  return `${clientName.replace(/[\\/:*?"<>|]/g, "").trim()} - Consolidated Keyword Ranking Report.xlsx`;
}

export class ConsolidatedReportUnavailableError extends Error {}

/** The consolidated report for a report, built from the client's saved history and the report's run. */
export async function buildConsolidatedForReport(reportId: string): Promise<ConsolidatedBuildResult & { filename: string }> {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, include: { client: { include: { consolidatedHistory: true } }, run: true } });
  const history = report.client.consolidatedHistory;
  if (!history) {
    throw new ConsolidatedReportUnavailableError(
      `${report.client.name} gets the consolidated report, but its consolidated history isn't uploaded yet -- upload the last consolidated Excel it received first (on the report's Attachments, or in Client Management).`,
    );
  }
  const rows = await prisma.rankingRow.findMany({ where: { runId: report.runId }, orderBy: { sourceRowNumber: "asc" }, select: { keyword: true, rankValue: true, rankDisplay: true } });
  const reportDate = report.reportDate ?? report.run.completedAt ?? report.run.createdAt;
  if (reportDate.toISOString().slice(0, 10) <= history.newestDate.toISOString().slice(0, 10)) {
    throw new ConsolidatedReportUnavailableError(
      `The consolidated history already goes up to ${history.newestDate.toISOString().slice(0, 10)}, but this report is dated ${reportDate.toISOString().slice(0, 10)} -- it would add an older column in front. Upload the right consolidated file in Client Management, or check the report date.`,
    );
  }
  const built = await buildConsolidatedReport(Buffer.from(history.file), { reportDate, rows });
  return { ...built, filename: consolidatedFilename(report.client.name) };
}

/** Saves the consolidated report that was just sent as the client's history, so the next one builds on it. */
export async function saveSentConsolidated(clientId: string, file: { buffer: Buffer; filename: string }, reportId: string, by: string | null) {
  const info = await describeConsolidatedFile(file.buffer);
  await prisma.consolidatedHistory.upsert({
    where: { clientId },
    create: { clientId, filename: file.filename, file: file.buffer, newestDate: info.newestDate, dateColumns: info.dateColumns, keywordCount: info.keywordCount, source: "sent", reportId, updatedBy: by },
    update: { filename: file.filename, file: file.buffer, newestDate: info.newestDate, dateColumns: info.dateColumns, keywordCount: info.keywordCount, source: "sent", reportId, updatedBy: by },
  });
}
