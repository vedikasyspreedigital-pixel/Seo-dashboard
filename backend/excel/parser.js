import ExcelJS from 'exceljs';
import { COLUMN_HEADERS, REQUIRED_ROW_FIELDS, STATUS_TEXT, NOT_IN_100, locateColumns } from './mapping.js';
import { computeRowUid } from './rowUid.js';

// ExcelJS cell.value shapes we need to unwrap, recursively since a
// hyperlink's `text` can itself be a rich-text object (this is exactly
// what a copy-pasted URL becomes when Excel auto-hyperlinks it):
//   plain rich text:        { richText: [{ text: '...' }, ...] }
//   hyperlink, plain text:  { text: '...', hyperlink: '...' }
//   hyperlink, rich text:   { text: { richText: [...] }, hyperlink: '...' }
//   formula:                { formula: '...', result: '...' }
function extractCellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
    if ('text' in value) return extractCellText(value.text); // hyperlink wrapper
    if ('result' in value) return extractCellText(value.result); // formula
  }
  return String(value);
}

function cellText(row, colNumber) {
  return extractCellText(row.getCell(colNumber).value).trim();
}

function isRowBlank(values) {
  return Object.values(values).every((v) => v === '');
}

/**
 * "8" -> { rankValue: 8, rankDisplay: "8" }
 * "Not in 100" -> { rankValue: null, rankDisplay: "Not in 100" }
 * "" -> { rankValue: null, rankDisplay: null }
 * anything else -> passthrough as display text, rankValue null (lossless, not silently discarded)
 */
function parseRankCell(raw) {
  const trimmed = (raw ?? '').toString().trim();
  if (trimmed === '') return { rankValue: null, rankDisplay: null };
  if (trimmed.toLowerCase() === NOT_IN_100.toLowerCase()) {
    return { rankValue: null, rankDisplay: NOT_IN_100 };
  }
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber)) {
    return { rankValue: asNumber, rankDisplay: String(asNumber) };
  }
  return { rankValue: null, rankDisplay: trimmed };
}

function statusTextToEnum(rawStatus) {
  const trimmed = (rawStatus ?? '').toString().trim();
  if (trimmed === STATUS_TEXT.PENDING) return 'PENDING';
  if (trimmed === STATUS_TEXT.ERROR_RETRY) return 'ERROR_RETRY';
  if (trimmed === STATUS_TEXT.COMPLETED) return 'COMPLETED';
  return null;
}

/**
 * Parses an uploaded ranking Excel file into DB-ready row objects.
 *
 * @param {Buffer|ArrayBuffer} fileBuffer
 * @param {{ clientId: string, worksheetName?: string }} options
 * @returns {Promise<{ rows: object[], rowErrors: object[], totalDataRows: number }>}
 */
export async function parseRankingExcel(fileBuffer, { clientId, worksheetName } = {}) {
  if (!clientId) throw new Error('parseRankingExcel requires a clientId');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const worksheet = worksheetName ? workbook.getWorksheet(worksheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(`Worksheet not found${worksheetName ? `: ${worksheetName}` : ''}`);

  const headerRow = worksheet.getRow(1);
  const columns = locateColumns(headerRow);

  const rows = [];
  const rowErrors = [];
  let totalDataRows = 0;

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);

    const values = {
      keyword: cellText(row, columns.keyword),
      fullUrl: cellText(row, columns.fullUrl),
      targetUrl: cellText(row, columns.targetUrl),
      concatenate: cellText(row, columns.concatenate),
      locationName: cellText(row, columns.locationName),
      seDomain: cellText(row, columns.seDomain),
      languageName: cellText(row, columns.languageName),
      status: cellText(row, columns.status),
      rank: cellText(row, columns.rank),
      rankingUrl: cellText(row, columns.rankingUrl),
    };

    if (isRowBlank(values)) continue; // skip trailing/blank rows
    totalDataRows++;

    const missingFields = REQUIRED_ROW_FIELDS.filter((field) => values[field] === '');
    const statusEnum = statusTextToEnum(values.status);

    if (missingFields.length > 0 || statusEnum === null) {
      rowErrors.push({
        sourceRowNumber: rowNumber,
        reason:
          missingFields.length > 0
            ? `Missing required value(s): ${missingFields.map((field) => COLUMN_HEADERS[field]).join(', ')}`
            : `Unrecognized Status value: "${values.status}"`,
        raw: values,
      });
      continue;
    }

    const { rankValue, rankDisplay } = parseRankCell(values.rank);

    rows.push({
      sourceRowNumber: rowNumber,
      rowUid: computeRowUid({
        clientId,
        keyword: values.keyword,
        targetUrl: values.targetUrl,
        locationName: values.locationName,
        languageName: values.languageName,
        seDomain: values.seDomain,
      }),
      keyword: values.keyword,
      fullUrl: values.fullUrl || null,
      targetUrl: values.targetUrl,
      concatenate: values.concatenate || null,
      locationName: values.locationName,
      seDomain: values.seDomain,
      languageName: values.languageName,
      status: statusEnum,
      rankValue,
      rankDisplay,
      rankingUrl: values.rankingUrl || null,
    });
  }

  return { rows, rowErrors, totalDataRows };
}

export { COLUMN_HEADERS };
