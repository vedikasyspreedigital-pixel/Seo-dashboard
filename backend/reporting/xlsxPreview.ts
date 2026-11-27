import ExcelJS from "exceljs";

/**
 * An Excel file's contents as plain text tables, for the on-screen "Preview" (2026-11-27): the team checks a
 * Domain Intelligence file or an edited Baseline Report before it goes out, without downloading it. Every sheet,
 * first rows/columns only -- enough to check it, not a full spreadsheet viewer.
 */
export interface WorkbookPreview {
  sheets: { name: string; rows: string[][]; totalRows: number; truncated: boolean }[];
}

export class PreviewFileError extends Error {}

function cellText(cell: ExcelJS.Cell): string {
  // A merged title ("SEMrush" over 4 columns) shows once, in its first cell.
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return "";
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; hyperlink?: string };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("");
    if (o.result !== undefined && o.result !== null) return String(o.result);
    if (typeof o.text === "string") return o.text;
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(v);
}

export async function previewWorkbook(buffer: Buffer, { maxRows = 300, maxCols = 30 } = {}): Promise<WorkbookPreview> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new PreviewFileError("This file couldn't be opened as an Excel (.xlsx) file.");
  }
  return {
    sheets: wb.worksheets.map((ws) => {
      const cols = Math.min(ws.columnCount, maxCols);
      const rows: string[][] = [];
      for (let r = 1; r <= Math.min(ws.rowCount, maxRows); r++) {
        const row = ws.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c)).trim());
        rows.push(cells);
      }
      // Trailing empty rows and columns aren't worth showing.
      while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
      let width = cols;
      while (width > 0 && rows.every((r) => r[width - 1] === "")) width--;
      return { name: ws.name, rows: rows.map((r) => r.slice(0, width)), totalRows: ws.rowCount, truncated: ws.rowCount > maxRows || ws.columnCount > maxCols };
    }),
  };
}
