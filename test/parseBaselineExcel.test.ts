import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseBaselineExcel } from "../backend/baselines/parseBaselineExcel.js";

// Mirrors the real sample PDF's layout (2-row header where the "Keyword"
// label and the date labels share one row; a title/status row above it),
// so the same shape is verified for the Excel path.
async function buildWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rankings");
  sheet.addRow(["Current Ranking Status:", "Google.ae", "Google.ae"]);
  sheet.addRow(["Keyword", "31st August 2026", "17th August 2026"]);
  sheet.addRow(["best car accessories shop in abudhabi", "1", "1"]);
  sheet.addRow(["car seat covers mussafah", "2", "9"]);
  sheet.addRow(["headrest android screen", "32", "Not in100"]);
  sheet.addRow(["car wrapping abu dhabi", "Not in 100", "27"]);
  sheet.addRow(["car spare parts abu dhabi", "Not in 100", "Not in100"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("parseBaselineExcel: finds the header row even when it's not row 1, and auto-selects the newest date column", async () => {
  const preview = await parseBaselineExcel(await buildWorkbookBuffer());
  assert.equal(preview.detectedDates.length, 2);
  assert.equal(preview.baselineDateLabel, "31st August 2026");
  assert.equal(preview.rows.length, 5);
});

test("parseBaselineExcel: extracts ranks from the auto-selected (newest) column, not the older one", async () => {
  const preview = await parseBaselineExcel(await buildWorkbookBuffer());
  const row = preview.rows.find((r) => r.keyword === "car seat covers mussafah");
  assert.ok(row);
  assert.equal(row!.rankValue, 2, "must use the 31st August column (2), not the 17th August column (9)");
});

test("parseBaselineExcel: both 'Not in 100' and 'Not in100' spellings normalize to a null rank", async () => {
  const preview = await parseBaselineExcel(await buildWorkbookBuffer());
  const spacedInOlderColumn = preview.rows.find((r) => r.keyword === "headrest android screen");
  const spacedInNewerColumn = preview.rows.find((r) => r.keyword === "car wrapping abu dhabi");
  // "headrest android screen": newest column (31st Aug) = "32" -- ranked.
  assert.equal(spacedInOlderColumn!.rankValue, 32);
  // "car wrapping abu dhabi": newest column (31st Aug) = "Not in 100" -- unranked.
  assert.equal(spacedInNewerColumn!.rankValue, null);
  assert.equal(spacedInNewerColumn!.rankDisplay, "Not in 100");
});

test("parseBaselineExcel: falls back to date-column detection when the 'Keyword' header cell is genuinely blank -- a real agency export had this exact shape (the label was exported as a vector shape/outline, not real text, so no cell anywhere literally says \"Keyword\")", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Table 1");
  sheet.addRow(["Client Keyword Ranking Report", "Client Keyword Ranking Report", "Client Keyword Ranking Report"]);
  sheet.addRow([null, null, null]);
  sheet.addRow(["Current Ranking Status:", "Google.ae", "Google.ae"]);
  sheet.addRow([null, "31st August 2026", "17th August 2026"]); // "Keyword" label itself is blank -- only the dates are real text
  sheet.addRow(["best car accessories shop in abudhabi", "1", "1"]);
  sheet.addRow(["car accessories abu dhabi city", "1", "1"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseBaselineExcel(buffer);
  assert.equal(preview.detectedDates.length, 2);
  assert.equal(preview.baselineDateLabel, "31st August 2026");
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.rows[0].keyword, "best car accessories shop in abudhabi");
  assert.equal(preview.rows[0].rankValue, 1);
});

test("parseBaselineExcel: throws a clear error when no 'Keyword' column is found", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Term", "Rank"]);
  sheet.addRow(["something", "1"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => parseBaselineExcel(buffer), /Keyword/);
});
