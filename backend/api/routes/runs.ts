import { Router } from 'express';
import multer from 'multer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../db/client.js';
import { ingestExcelRun } from '../../runs/ingestExcelRun.js';
import { parseRankingExcel, COLUMN_HEADERS } from '../../excel/parser.js';
import { startRun, cancelRun } from '../../statemachine/runTransitions.js';
import { InvalidRunTransitionError } from '../../statemachine/errors.js';
import { exportRunExcelBuffer } from '../../excel/exportRunExcel.js';
import { processRun, type CallDataForSeoFn } from '../../worker/processRun.js';
import { requireAuth } from '../../auth/requireAuth.js';
import { findOwnedClientOrRespond, findOwnedRunOrRespond } from '../../auth/ownership.js';
import { expensiveActionRateLimit } from '../rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Configurable so a persistent disk (e.g. Render) can be mounted somewhere
// other than the repo checkout -- defaults to the existing local-dev path
// when UPLOADS_DIR isn't set, so nothing changes for local development.
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, '../../../uploads');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// .xlsx is a zip archive -- every valid one starts with this 4-byte local
// file header signature. Checked by content, not filename/mimetype (both
// trivially spoofable from a raw multipart request), same principle as the
// existing custom-PDF-upload's "%PDF-" check (reports.ts). Previously this
// route accepted anything up to 25MB and relied entirely on ExcelJS
// throwing later inside parseRankingExcel -- cheap to reject obviously
// wrong files before spending any parsing effort on them.
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).equals(XLSX_MAGIC);
}

function countFor(counts: { status: string; _count: { _all: number } }[], status: string): number {
  return counts.find((c) => c.status === status)?._count._all ?? 0;
}

export function createRunsRouter(callDataForSeo: CallDataForSeoFn) {
  const router = Router();
  router.use(requireAuth);

  router.post('/', expensiveActionRateLimit, upload.single('file'), async (req, res) => {
    const clientId = req.body?.clientId as string | undefined;
    const file = req.file;
    if (!clientId || !file) {
      res.status(400).json({ error: 'clientId and file are required' });
      return;
    }
    if (!(await findOwnedClientOrRespond(req, res, clientId, { requireActive: true }))) return;
    if (!looksLikeXlsx(file.buffer)) {
      res.status(400).json({ error: "File does not look like a valid .xlsx workbook." });
      return;
    }

    // Idempotency guard against a rapid duplicate submission (double-click,
    // a slow request retried by the browser/network) creating two separate
    // runs for the same upload -- not a full dedupe (re-uploading the same
    // filename later, deliberately, must still work), just a short window
    // that catches genuine accidental double-submits. Returns the
    // already-created run rather than erroring, so a duplicate click just
    // silently resolves to the one real run instead of surfacing a
    // confusing error to the user.
    const recentDuplicate = await prisma.rankingRun.findFirst({
      where: { clientId, sourceFilename: file.originalname, createdAt: { gte: new Date(Date.now() - 10_000) } },
      orderBy: { createdAt: "desc" },
    });
    if (recentDuplicate) {
      res.status(200).json({ run: recentDuplicate, insertedRowCount: recentDuplicate.totalRows, rowErrors: [] });
      return;
    }

    try {
      const { run, insertedRowCount, rowErrors } = await ingestExcelRun({
        clientId,
        sourceFilename: file.originalname,
        sourceFilePath: file.originalname, // placeholder, replaced below once we know run.id
        fileBuffer: file.buffer,
      });

      await mkdir(UPLOADS_DIR, { recursive: true });
      const storedPath = path.join(UPLOADS_DIR, `${run.id}.xlsx`);
      await writeFile(storedPath, file.buffer);
      await prisma.rankingRun.update({ where: { id: run.id }, data: { sourceFilePath: storedPath } });

      res.status(201).json({ run: { ...run, sourceFilePath: storedPath }, insertedRowCount, rowErrors });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Preview only: parses the file with the same tested parser used at
  // real creation time, but writes nothing (no run, no rows, no file on
  // disk). Backs the "detected columns / N rows ready" preview shown right
  // after picking a file, before the user commits to Upload & Create Run.
  router.post('/validate', upload.single('file'), async (req, res) => {
    const clientId = req.body?.clientId as string | undefined;
    const file = req.file;
    if (!clientId || !file) {
      res.status(400).json({ error: 'clientId and file are required' });
      return;
    }
    if (!(await findOwnedClientOrRespond(req, res, clientId, { requireActive: true }))) return;
    if (!looksLikeXlsx(file.buffer)) {
      res.status(400).json({ error: "File does not look like a valid .xlsx workbook." });
      return;
    }

    try {
      const { rows, rowErrors } = await parseRankingExcel(file.buffer, { clientId });
      res.json({
        insertedRowCount: rows.length,
        rowErrorCount: rowErrors.length,
        rowErrors: rowErrors.slice(0, 5),
        detectedColumns: Object.values(COLUMN_HEADERS),
        fileSizeBytes: file.size,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/start', expensiveActionRateLimit, async (req, res) => {
    if (!(await findOwnedRunOrRespond(req, res, req.params.id as string, { requireActive: true }))) return;
    try {
      const run = await startRun(req.params.id as string);
      // Fire-and-forget: the HTTP response returns immediately, the
      // dashboard polls /progress. A failure here is logged, not thrown at
      // the client -- the affected rows simply stay in whatever state
      // processRun left them (their own transition guards protect them).
      processRun(run.id, callDataForSeo).catch((err) => {
        console.error(`processRun failed for run ${run.id}:`, err);
      });
      res.json(run);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // List: runs for a client, most recent first -- backs the Runs list page.
  router.get('/', async (req, res) => {
    const clientId = req.query.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      res.status(400).json({ error: 'clientId query parameter is required' });
      return;
    }
    if (!(await findOwnedClientOrRespond(req, res, clientId))) return;
    const runs = await prisma.rankingRun.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    res.json(runs);
  });

  // UPLOADED | PROCESSING -> CANCELLED. Was already implemented in the
  // state machine but never exposed via the router.
  router.post('/:id/cancel', async (req, res) => {
    if (!(await findOwnedRunOrRespond(req, res, req.params.id, { requireActive: true }))) return;
    try {
      const run = await cancelRun(req.params.id);
      res.json(run);
    } catch (err) {
      if (err instanceof InvalidRunTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/:id', async (req, res) => {
    const run = await findOwnedRunOrRespond(req, res, req.params.id);
    if (!run) return;
    res.json(run);
  });

  // Row-level detail for the Run Detail page's table -- keyword/location/
  // language/status/rank/ranking URL for every row, source order.
  router.get('/:id/rows', async (req, res) => {
    const runId = req.params.id;
    if (!(await findOwnedRunOrRespond(req, res, runId))) return;
    const rows = await prisma.rankingRow.findMany({
      where: { runId },
      orderBy: { sourceRowNumber: 'asc' },
      select: {
        id: true,
        sourceRowNumber: true,
        keyword: true,
        locationName: true,
        languageName: true,
        status: true,
        rankDisplay: true,
        rankingUrl: true,
      },
    });
    res.json(rows);
  });

  router.get('/:id/progress', async (req, res) => {
    const runId = req.params.id;
    const run = await findOwnedRunOrRespond(req, res, runId);
    if (!run) return;

    const counts = await prisma.rankingRow.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });

    res.json({
      runStatus: run.status,
      total: run.totalRows,
      pending: countFor(counts, 'PENDING'),
      processing: countFor(counts, 'PROCESSING'),
      completed: countFor(counts, 'COMPLETED'),
      errorRetry: countFor(counts, 'ERROR_RETRY'),
      failed: countFor(counts, 'FAILED'),
    });
  });

  router.get('/:id/export', async (req, res) => {
    const runId = req.params.id;
    if (!(await findOwnedRunOrRespond(req, res, runId))) return;

    const { buffer: updatedBuffer, filename } = await exportRunExcelBuffer(runId);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.send(updatedBuffer);
  });

  return router;
}
