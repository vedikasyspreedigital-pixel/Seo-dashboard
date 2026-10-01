import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseBaselineExcel } from "../backend/baselines/parseBaselineExcel.js";
import { isSearchEngineDomainCell } from "../backend/baselines/normalizeKeyword.js";

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

// Regression: a real agency export (Altered Images Photography, 2026-09-21)
// put a 4-row title block above the table, with the report date merged
// across every column, so "Keyword" sat on row 6. The old 5-row search
// missed it, took the merged title-date row as the header, stored the 15th
// September ranks under "31st August 2026", and imported the two header
// rows below it ("Current Ranking Status:", "Keyword") as keywords.
async function buildTitledReportBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ranking");
  sheet.addRow(["Client Keyword Ranking Report"]);
  sheet.addRow(["alteredimages.com.au"]);
  sheet.addRow(["31st August 2026"]);
  sheet.mergeCells("A1:C1");
  sheet.mergeCells("A2:C2");
  sheet.mergeCells("A3:C3");
  sheet.addRow([]);
  sheet.addRow(["Current Ranking Status:", "Google.com.au", "Google.com.au"]);
  sheet.addRow(["Keyword", "15th September 2026", "31st August 2026"]);
  sheet.addRow(["commercial photography services", 2, "Not in 100"]);
  sheet.addRow(["commercial photographer melbourne", "3", 3]);
  sheet.addRow(["portrait photography melbourne", "Not in 100", "Not in 100"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("parseBaselineExcel: finds a 'Keyword' header below a title block (row 6) and picks the real newest column, not the title's date", async () => {
  const preview = await parseBaselineExcel(await buildTitledReportBuffer());
  assert.equal(preview.baselineDateLabel, "15th September 2026");
  assert.equal(preview.baselineDate, new Date(Date.UTC(2026, 8, 15)).toISOString());
  assert.deepEqual(
    preview.rows.map((r) => r.keyword),
    ["commercial photography services", "commercial photographer melbourne", "portrait photography melbourne"],
    "title/header rows must never be imported as keywords",
  );
  assert.equal(preview.rows[0].rankValue, 2, "rank comes from the 15th September column");
});

test("parseBaselineExcel: a 'Keywords' (plural) header label is recognized too", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rankings");
  sheet.addRow(["Keywords", "15th September 2026", "31st August 2026"]);
  sheet.addRow(["commercial photography services", "2", "Not in 100"]);
  const preview = await parseBaselineExcel(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(preview.baselineDateLabel, "15th September 2026");
  assert.equal(preview.rows.length, 1);
});

test("parseBaselineExcel: a merged title row repeating ONE date is never taken as the header row", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rankings");
  sheet.addRow(["31st August 2026"]);
  sheet.mergeCells("A1:C1");
  sheet.addRow(["", "15th September 2026", "31st August 2026"]); // blank Keyword cell -- strategy 2
  sheet.addRow(["commercial photography services", "2", "Not in 100"]);
  const preview = await parseBaselineExcel(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(preview.baselineDateLabel, "15th September 2026");
  assert.deepEqual(preview.rows.map((r) => r.keyword), ["commercial photography services"]);
});

// Regression: a multi-location agency report (Twin Crown, 2026-09) groups
// keywords under location section rows ("Saudi Arabia | google.com.sa |
// google.com.sa"); those, and the top "Current Ranking Status: | Google.ae"
// row, must never be imported as keywords.
test("parseBaselineExcel: multi-location report -- location section rows are not imported as keywords", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ranking");
  sheet.addRow(["Current Ranking Status:", "Google.ae", "Google.ae"]);
  sheet.addRow(["Keyword", "15th September 2026", "31st August 2026"]);
  sheet.addRow(["tcs meters uae", "1", "1"]);
  sheet.addRow(["oilfield equipment suppliers in dubai", "1", "Not in 100"]);
  sheet.addRow(["Saudi Arabia", "google.com.sa", "google.com.sa"]);
  sheet.addRow(["flow meter suppliers in saudi arabia", "19", "14"]);
  sheet.addRow(["Congo", "Not In 100", "google.cg"]);
  sheet.addRow(["fuel flow meters supplier congo", "1", "1"]);
  sheet.addRow(["Somalia", "google.com", "google.com"]);
  sheet.addRow(["fuel flow meters somalia", "1", "1"]);
  const preview = await parseBaselineExcel(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(preview.baselineDateLabel, "15th September 2026");
  assert.deepEqual(
    preview.rows.map((r) => r.keyword),
    ["tcs meters uae", "oilfield equipment suppliers in dubai", "flow meter suppliers in saudi arabia", "fuel flow meters supplier congo", "fuel flow meters somalia"],
  );
  assert.equal(preview.rows.find((r) => r.keyword === "flow meter suppliers in saudi arabia")!.rankValue, 19);
});

test("isSearchEngineDomainCell: Google domains in a rank cell are section markers; ranks are not", () => {
  for (const cell of ["google.com.sa", "Google.ae", "google.com", "www.google.co.in", "https://google.cg/"]) assert.equal(isSearchEngineDomainCell(cell), true, cell);
  for (const cell of ["1", "19", "Not in 100", "Not In 100", "", null, "googled", "flow meter google ads"]) assert.equal(isSearchEngineDomainCell(cell), false, String(cell));
});
