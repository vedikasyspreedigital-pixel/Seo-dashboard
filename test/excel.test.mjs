import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildSampleWorkbook } from "../scripts/create-sample-excel.mjs";
import { parseRankingExcel } from "../backend/excel/parser.js";
import { exportRankingExcel } from "../backend/excel/exporter.js";
import { computeRowUid } from "../backend/excel/rowUid.js";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";

const CLIENT_ID = "client-cash-for-cars";

async function sampleBuffer() {
  const workbook = await buildSampleWorkbook();
  return workbook.xlsx.writeBuffer();
}

test("parses the locked cash-for-cars-perth row exactly", async () => {
  const buffer = await sampleBuffer();
  const { rows } = await parseRankingExcel(buffer, { clientId: CLIENT_ID });

  const row = rows.find((r) => r.keyword === "cash for cars perth");
  assert.equal(row.targetUrl, "*cash-for-cars-perth.*"); // verbatim, not normalized
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.rankValue, 8);
  assert.equal(row.rankDisplay, "8");
  assert.equal(row.rankingUrl, "https://www.cash-for-cars-perth.com.au/");
});

test("maps Pending and Error - Retry statuses, leaves rank blank", async () => {
  const buffer = await sampleBuffer();
  const { rows } = await parseRankingExcel(buffer, { clientId: CLIENT_ID });

  const pending = rows.find((r) => r.keyword === "sell my car perth");
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.rankValue, null);
  assert.equal(pending.rankDisplay, null);

  const retry = rows.find((r) => r.keyword === "car removal perth");
  assert.equal(retry.status, "ERROR_RETRY");
});

test("rows missing a required field are reported as errors, not silently dropped or guessed", async () => {
  const buffer = await sampleBuffer();
  const { rows, rowErrors } = await parseRankingExcel(buffer, {
    clientId: CLIENT_ID,
  });

  assert.equal(
    rows.find((r) => r.keyword === "scrap car perth"),
    undefined,
  );
  assert.equal(rowErrors.length, 1);
  assert.match(rowErrors[0].reason, /Location/);
});

test("row_uid is stable for identical input and differs across clients", () => {
  const base = {
    clientId: CLIENT_ID,
    keyword: "cash for cars perth",
    targetUrl: "*cash-for-cars-perth.*",
    locationName: "Australia",
    languageName: "English",
    seDomain: "google.com.au",
  };
  assert.equal(computeRowUid(base), computeRowUid(base));
  assert.notEqual(
    computeRowUid(base),
    computeRowUid({ ...base, clientId: "other-client" }),
  );
});

test("export patches only Status/Ranks/Ranking URL for touched rows, leaves everything else untouched", async () => {
  const originalBuffer = await sampleBuffer();
  const { rows } = await parseRankingExcel(originalBuffer, {
    clientId: CLIENT_ID,
  });

  const pending = rows.find((r) => r.keyword === "sell my car perth");
  const retry = rows.find((r) => r.keyword === "car removal perth");

  const updatedBuffer = await exportRankingExcel(originalBuffer, [
    {
      sourceRowNumber: pending.sourceRowNumber,
      status: "COMPLETED",
      rankDisplay: "14",
      rankingUrl: "https://www.cash-for-cars-perth.com.au/sell-my-car",
    },
    {
      sourceRowNumber: retry.sourceRowNumber,
      status: "FAILED", // DB-only terminal state -> rendered as "Error - Retry" in Excel
      rankDisplay: null,
      rankingUrl: null,
    },
  ]);

  const { rows: exportedRows } = await parseRankingExcel(updatedBuffer, {
    clientId: CLIENT_ID,
  });

  const exportedPending = exportedRows.find(
    (r) => r.keyword === "sell my car perth",
  );
  assert.equal(exportedPending.status, "COMPLETED");
  assert.equal(exportedPending.rankDisplay, "14");
  assert.equal(
    exportedPending.rankingUrl,
    "https://www.cash-for-cars-perth.com.au/sell-my-car",
  );

  const exportedRetry = exportedRows.find(
    (r) => r.keyword === "car removal perth",
  );
  assert.equal(exportedRetry.status, "ERROR_RETRY"); // "Error - Retry" text, re-parses back to this enum
  assert.equal(exportedRetry.rankDisplay, null);

  // Untouched row must survive byte-for-byte in the fields we can observe post-parse.
  const untouched = exportedRows.find(
    (r) => r.keyword === "cash for cars perth",
  );
  assert.equal(untouched.status, "COMPLETED");
  assert.equal(untouched.rankDisplay, "8");
  assert.equal(untouched.fullUrl, "cash-for-cars-perth.com.au");
  assert.equal(
    untouched.concatenate,
    "cash for cars perth cash-for-cars-perth.com.au",
  );
});

// Regression test: a real uploaded file had its Domain cell auto-hyperlinked
// by Excel (copy-pasting a URL does this). ExcelJS represents that as
// { text: { richText: [...] }, hyperlink: '...' } -- a rich-text object
// nested *inside* a hyperlink wrapper, one level deeper than a plain
// hyperlink or a plain rich-text cell. The parser previously stringified
// that nested object directly, producing the literal text "[object Object]",
// which DataForSEO then rejected as an invalid se_domain value.
test("cells auto-hyperlinked by Excel (rich text nested inside a hyperlink) are read as their real text, not '[object Object]'", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(Object.values(COLUMN_HEADERS));
  const row = sheet.addRow([
    "car wreckers mandurah",
    "wawreckers.com.au",
    "*wawreckers.*",
    "car wreckers mandurah wawreckers.com.au",
    "Australia",
    "", // Domain -- set below as a hyperlink-wrapped rich-text cell
    "English",
    "Pending",
    "",
    "",
  ]);

  // Exact shape ExcelJS produces for a cell containing an auto-hyperlinked,
  // rich-text-formatted URL (the shape found in the real failing file).
  row.getCell(6).value = {
    text: { richText: [{ font: { underline: true, color: { argb: "FF1155CC" } }, text: "google.com.au" }] },
    hyperlink: "http://google.com.au/",
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const { rows, rowErrors } = await parseRankingExcel(buffer, { clientId: CLIENT_ID });

  assert.equal(rowErrors.length, 0);
  assert.equal(rows[0].seDomain, "google.com.au");
});

test("a plain (non-hyperlinked) rich-text cell is also read as its real text", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(Object.values(COLUMN_HEADERS));
  const row = sheet.addRow([
    "car wreckers",
    "wawreckers.com.au",
    "*wawreckers.*",
    "car wreckers wawreckers.com.au",
    "Australia",
    "google.com.au",
    "",
    "Pending",
    "",
    "",
  ]);

  // No hyperlink, just mixed formatting -- { richText: [...] } at the top level.
  row.getCell(7).value = { richText: [{ font: { bold: true }, text: "Eng" }, { text: "lish" }] };

  const buffer = await workbook.xlsx.writeBuffer();
  const { rows, rowErrors } = await parseRankingExcel(buffer, { clientId: CLIENT_ID });

  assert.equal(rowErrors.length, 0);
  assert.equal(rows[0].languageName, "English");
});
