import ExcelJS from 'exceljs';
import { locateColumns, ROW_STATUS_TO_EXCEL_TEXT } from './mapping.js';

/**
 * Re-opens the ORIGINAL uploaded workbook and patches only the
 * Status / Ranks / Ranking URL cells for the given rows. Every other
 * cell -- including columns this pipeline never reads (K..CZ) and any
 * cell formatting -- is left exactly as uploaded.
 *
 * @param {Buffer|ArrayBuffer} originalFileBuffer
 * @param {{ sourceRowNumber: number, status: string, rankDisplay: string|null, rankingUrl: string|null }[]} updates
 * @param {{ worksheetName?: string }} [options]
 * @returns {Promise<Buffer>}
 */
export async function exportRankingExcel(originalFileBuffer, updates, { worksheetName } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(originalFileBuffer);

  const worksheet = worksheetName ? workbook.getWorksheet(worksheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(`Worksheet not found${worksheetName ? `: ${worksheetName}` : ''}`);

  const columns = locateColumns(worksheet.getRow(1));

  for (const update of updates) {
    const row = worksheet.getRow(update.sourceRowNumber);
    const statusText = ROW_STATUS_TO_EXCEL_TEXT[update.status];
    if (!statusText) throw new Error(`Unknown row status: ${update.status}`);

    row.getCell(columns.status).value = statusText;
    row.getCell(columns.rank).value = update.rankDisplay ?? '';
    row.getCell(columns.rankingUrl).value = update.rankingUrl ?? '';
    row.commit();
  }

  return workbook.xlsx.writeBuffer();
}
