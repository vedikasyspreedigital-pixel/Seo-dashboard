// Converts an .xlsx buffer to a PDF buffer, for attaching the actual
// ranking Excel (not just the deterministic HTML report) to client emails.
// No LibreOffice/external converter dependency -- reads the workbook with
// exceljs (already a project dependency), renders it as a plain HTML
// table, and prints that to PDF with Playwright (already a dependency for
// the ClickUp Email Agent). Formatting fidelity is basic (values only, no
// original cell styling) but every column/row the workbook actually has is
// included.

import ExcelJS from "exceljs";
import { chromium } from "playwright";

export async function convertExcelBufferToPdf(excelBuffer: Buffer, options: { sheetName?: string } = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBuffer as unknown as ExcelJS.Buffer);

  const worksheet = options.sheetName ? workbook.getWorksheet(options.sheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(`Worksheet not found${options.sheetName ? `: ${options.sheetName}` : ""}`);

  const html = renderWorksheetHtml(worksheet, workbook.creator || "Ranking Export");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", landscape: true, printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
    return pdf;
  } finally {
    await browser.close();
  }
}

function renderWorksheetHtml(worksheet: ExcelJS.Worksheet, title: string): string {
  const columnCount = worksheet.columnCount;
  const rowsHtml: string[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cellsHtml: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      const cell = row.getCell(col);
      const text = escapeHtml(cellValueToText(cell.value));
      const tag = rowNumber === 1 ? "th" : "td";
      cellsHtml.push(`<${tag}>${text}</${tag}>`);
    }
    rowsHtml.push(`<tr>${cellsHtml.join("")}</tr>`);
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #111; }
  h1 { font-size: 14px; margin: 0 0 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 3px 5px; text-align: left; white-space: nowrap; }
  th { background: #f0f0f0; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <table>${rowsHtml.join("")}</table>
</body>
</html>`;
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // Rich text / formula / hyperlink cell objects -- checked recursively,
    // since a hyperlink cell's own `.text` is itself often a richText
    // object rather than a plain string (e.g. {text: {richText: [...]},
    // hyperlink: "..."}), one level deeper than a single flat check catches.
    if ("richText" in value && Array.isArray((value as any).richText)) {
      return (value as any).richText.map((rt: any) => rt.text).join("");
    }
    if ("result" in value) return cellValueToText((value as any).result);
    if ("text" in value) return cellValueToText((value as any).text);
    return String(value);
  }
  return String(value);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
