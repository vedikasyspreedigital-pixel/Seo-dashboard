import ExcelJS from "exceljs";
import { SOURCE_LABELS, type KeywordRow, type KeywordSource } from "./readKeywordExport.js";

// Domain Intelligence Excel layout, matching the agreed sample: one block per
// tool side by side on a single sheet, each with a yellow title row (the
// tool's name) over a blue header row, an empty spacer column between blocks.
// Each tool keeps its own columns and its own positions -- nothing is merged
// or averaged across tools. An individual report is the same sheet with one
// block.

export interface ReportBlock {
  source: KeywordSource;
  /** intent: the tool's own label(s), e.g. "Informational, Transactional", or the generated one. */
  rows: (KeywordRow & { intent: string })[];
}

type Column = { header: string; width: number; value: (r: ReportBlock["rows"][number]) => string | number | null };

// Header wording per tool, as in the sample (Semrush: Position / Search Volume; the others: Volume / Current position).
const COLUMNS: Record<KeywordSource, Column[]> = {
  semrush: [
    { header: "Keyword", width: 38, value: (r) => r.keyword },
    { header: "Position", width: 11, value: (r) => r.position },
    { header: "Search Volume", width: 15, value: (r) => r.volume },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
  ubersuggest: [
    { header: "Keyword", width: 38, value: (r) => r.keyword },
    { header: "Volume", width: 11, value: (r) => r.volume },
    { header: "Current position", width: 16, value: (r) => r.position },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
  ahrefs: [
    { header: "Keywords", width: 38, value: (r) => r.keyword },
    { header: "Volume", width: 11, value: (r) => r.volume },
    { header: "Current position", width: 16, value: (r) => r.position },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
};

const SOURCE_ORDER: KeywordSource[] = ["semrush", "ubersuggest", "ahrefs"];
const YELLOW = "FFFFFF00";
const BLUE = "FF4472C4";
const GRID = { style: "thin" as const, color: { argb: "FFD9D9D9" } };
const BORDER = { top: GRID, left: GRID, bottom: GRID, right: GRID };
const SPACER_WIDTH = 6;

export async function buildDomainReportExcel(blocks: ReportBlock[]): Promise<Buffer> {
  const ordered = SOURCE_ORDER.map((s) => blocks.find((b) => b.source === s)).filter((b): b is ReportBlock => !!b);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Domain Keywords", { views: [{ state: "frozen", ySplit: 2 }] });

  let startCol = 1;
  for (const block of ordered) {
    const columns = COLUMNS[block.source];
    const endCol = startCol + columns.length - 1;

    sheet.mergeCells(1, startCol, 1, endCol);
    const title = sheet.getCell(1, startCol);
    title.value = SOURCE_LABELS[block.source];
    title.font = { bold: true, size: 12 };
    title.alignment = { horizontal: "center", vertical: "middle" };
    for (let c = startCol; c <= endCol; c++) {
      sheet.getCell(1, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
      sheet.getCell(1, c).border = BORDER;
    }

    columns.forEach((col, i) => {
      const c = startCol + i;
      sheet.getColumn(c).width = col.width;
      const cell = sheet.getCell(2, c);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = BORDER;

      block.rows.forEach((row, r) => {
        const dataCell = sheet.getCell(3 + r, c);
        dataCell.value = col.value(row);
        dataCell.border = BORDER;
        if (i > 0 && col.header !== "Intent") dataCell.alignment = { horizontal: "right" };
      });
    });

    sheet.getColumn(endCol + 1).width = SPACER_WIDTH;
    startCol = endCol + 2;
  }
  sheet.getRow(1).height = 20;
  sheet.getRow(2).height = 18;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
