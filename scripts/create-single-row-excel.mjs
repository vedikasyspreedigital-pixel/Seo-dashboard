import ExcelJS from 'exceljs';
import { COLUMN_HEADERS } from '../backend/excel/mapping.js';

// One row only, for the controlled real-API test.
const ROW = [
  'cash for cars perth',
  'cash-for-cars-perth.com.au',
  '*cash-for-cars-perth.*',
  'cash for cars perth cash-for-cars-perth.com.au',
  'Australia',
  'google.com.au',
  'English',
  'Pending',
  '',
  '',
];

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Sheet1');
sheet.addRow(Object.values(COLUMN_HEADERS));
sheet.addRow(ROW);

const outPath = new URL('../sample-data/single-row-live-test.xlsx', import.meta.url);
await workbook.xlsx.writeFile(outPath);
console.log(`Wrote ${outPath}`);
