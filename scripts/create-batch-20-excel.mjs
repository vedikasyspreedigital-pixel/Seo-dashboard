import ExcelJS from 'exceljs';
import { COLUMN_HEADERS } from '../backend/excel/mapping.js';

// First 20 of the 33 rows supplied by the user (scope was capped at 10-20).
const ROWS = [
  ['cash for cars perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cash for cars perth wa', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cash for car removal perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car for cash removal', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cash for cars rockingham', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car removal perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'car removal perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cash for car removal', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for car removal cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car removals perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'car removals perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cash for cars', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cash for cars cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car wreckers', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'car wreckers cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['toyota wreckers', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'toyota wreckers cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['wreckers perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'wreckers perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car wreckers perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'car wreckers perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['auto wreckers perth', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'auto wreckers perth cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['mazda wreckers', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'mazda wreckers cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['car removal', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'car removal cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['hyundai wreckers', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'hyundai wreckers cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['cars sold for cash', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'cars sold for cash cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['sell cars for cash', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'sell cars for cash cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
  ['sell my vehicle for cash', 'cash-for-cars-perth.com.au', '*cash-for-cars-perth.*', 'sell my vehicle for cash cash-for-cars-perth.com.au', 'Australia', 'google.com.au', 'English', 'Pending', '', ''],
];

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Sheet1');
sheet.addRow(Object.values(COLUMN_HEADERS));
for (const row of ROWS) sheet.addRow(row);

const outPath = new URL('../sample-data/batch-20-live-test.xlsx', import.meta.url);
await workbook.xlsx.writeFile(outPath);
console.log(`Wrote ${outPath} (${ROWS.length} rows)`);
