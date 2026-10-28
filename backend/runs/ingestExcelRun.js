import { prisma } from '../db/client.js';
import { parseRankingExcel } from '../excel/parser.js';

/**
 * Parses an uploaded ranking Excel file and persists it as a ranking_run
 * plus its ranking_rows, inside a single transaction. Rows that fail
 * validation (see parser.js) are returned as rowErrors, not inserted.
 *
 * @param {{ clientId: string, sourceFilename: string, sourceFilePath: string,
 *           fileBuffer: Buffer|ArrayBuffer, createdBy?: string }} input
 */
export async function ingestExcelRun({ clientId, sourceFilename, sourceFilePath, fileBuffer, createdBy }) {
  const { rows, rowErrors, totalDataRows } = await parseRankingExcel(fileBuffer, { clientId });
  // A run with no usable rows used to be created anyway -- and starting it marked it "Completed" at once
  // (audit 2026-10-27). Refused instead, with the first reason a row was skipped.
  if (rows.length === 0) {
    throw new Error(`No keyword rows could be read from this file${rowErrors[0] ? ` (row ${rowErrors[0].sourceRowNumber}: ${rowErrors[0].reason})` : ''} -- nothing was created.`);
  }

  const run = await prisma.$transaction(async (tx) => {
    const createdRun = await tx.rankingRun.create({
      data: {
        clientId,
        sourceFilename,
        sourceFilePath,
        totalRows: rows.length,
        createdBy: createdBy ?? null,
        status: 'UPLOADED',
      },
    });

    // All rows in one insert (in batches): one insert per row, inside the transaction's 5-second limit,
    // made a big keyword file fail with "Transaction already closed" (audit 2026-10-27).
    const data = rows.map((row) => ({
      runId: createdRun.id,
      rowUid: row.rowUid,
      sourceRowNumber: row.sourceRowNumber,
      keyword: row.keyword,
      fullUrl: row.fullUrl,
      targetUrl: row.targetUrl,
      concatenate: row.concatenate,
      locationName: row.locationName,
      seDomain: row.seDomain,
      languageName: row.languageName,
      status: row.status,
      rankValue: row.rankValue,
      rankDisplay: row.rankDisplay,
      rankingUrl: row.rankingUrl,
    }));
    for (let i = 0; i < data.length; i += 1000) await tx.rankingRow.createMany({ data: data.slice(i, i + 1000) });

    return createdRun;
  }, { timeout: 60_000 });

  return { run, insertedRowCount: rows.length, rowErrors, totalDataRows };
}
