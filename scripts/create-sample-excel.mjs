import ExcelJS from "exceljs";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";

// Fixture matching the locked cash-for-cars-perth example, plus a few
// neighboring cases to exercise the parser: an Error-Retry row, an
// already-Completed row (should pass through untouched), and one bad row.
export async function buildSampleWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  sheet.addRow(Object.values(COLUMN_HEADERS));

  sheet.addRow([
    "cash for cars perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "cash for cars perth cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Completed",
    8,
    "https://www.cash-for-cars-perth.com.au/",
  ]);

  sheet.addRow([
    "sell my car perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "sell my car perth cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ]);

  sheet.addRow([
    "car removal perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "car removal perth cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Error - Retry",
    "",
    "",
  ]);

  // Missing Location -> should surface as a rowError, not a thrown parse.
  sheet.addRow([
    "scrap car perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "scrap car perth cash-for-cars-perth.com.au",
    "",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ]);

  return workbook;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workbook = await buildSampleWorkbook();
  const outPath = new URL(
    "../sample-data/cash-for-cars-perth.xlsx",
    import.meta.url,
  );
  await workbook.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath}`);
}
