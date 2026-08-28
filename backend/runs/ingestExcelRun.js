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

    for (const row of rows) {
      await tx.rankingRow.create({
        data: {
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
        },
      });
    }

    return createdRun;
  });

  return { run, insertedRowCount: rows.length, rowErrors, totalDataRows };
}
