import ExcelJS from "exceljs";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";

// The 5 real rows supplied by the user, all Pending, Ranks/Ranking URL blank.
const ROWS = [
  [
    "cash for cars perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "cash for cars perth cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ],
  [
    "cash for cars perth wa",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "cash for cars perth wa cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ],
  [
    "cash for car removal perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "cash for car removal perth cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ],
  [
    "car for cash removal",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "car for cash removal cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ],
  [
    "cash for cars rockingham",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "cash for cars rockingham cash-for-cars-perth.com.au",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ],
];

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Sheet1");
sheet.addRow(Object.values(COLUMN_HEADERS));
for (const row of ROWS) sheet.addRow(row);

const outPath = new URL("../sample-data/real-batch-test.xlsx", import.meta.url);
await workbook.xlsx.writeFile(outPath);
console.log(`Wrote ${outPath} (${ROWS.length} rows)`);
