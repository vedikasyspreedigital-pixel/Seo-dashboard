import { Router } from 'express';
import multer from 'multer';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../db/client.js';
import { ingestExcelRun } from '../../runs/ingestExcelRun.js';
import { parseRankingExcel, COLUMN_HEADERS } from '../../excel/parser.js';
import { startRun, cancelRun, rerunFailedRows } from '../../statemachine/runTransitions.js';
import { InvalidRunTransitionError } from '../../statemachine/errors.js';
import { exportRunExcelBuffer } from '../../excel/exportRunExcel.js';
import { deleteExtraAttachmentFiles } from '../../reporting/extraAttachments.js';
import { processVerifiedExcelUpload, describeRegenerationBlock, describeReportGeneration } from '../../reporting/processVerifiedExcelUpload.js';
import { processRun, type CallDataForSeoFn } from '../../worker/processRun.js';
import { callDataForSeoLive, hasDataForSeoCredentials, MISSING_CREDENTIALS_MESSAGE } from '../../dataforseo/client.js';
import { requireAuth } from '../../auth/requireAuth.js';
import { findOwnedClientOrRespond, findOwnedRunOrRespond } from '../../auth/ownership.js';
import { expensiveActionRateLimit } from '../rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Configurable so a persistent disk (e.g. Render) can be mounted somewhere
// other than the repo checkout -- defaults to the existing local-dev path
// when UPLOADS_DIR isn't set, so nothing changes for local development.
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, '../../../uploads');
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, '../../../reports');

/**
 * Deletes a run's stored file -- but only inside the app's own uploads/reports folders. A run whose file
 * never got saved kept the uploaded NAME as its path, so deleting it removed a file of that name from the
 * server's working folder (an upload called "package.json"...). Audit 2026-10-27.
 */
async function removeOwnFile(filePath: string) {
  const resolved = path.resolve(filePath);
  const inside = [UPLOADS_DIR, REPORTS_DIR].some((dir) => resolved.startsWith(dir + path.sep));
  if (!inside) {
    console.warn(`[runs] not deleting ${filePath}: it isn't in the uploads or reports folder`);
    return;
  }
  await unlink(resolved).catch(() => undefined);
}

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
  /** Uploads being created right now (client + file name + size) -> the run they're creating. */
  const uploadsInFlight = new Map<string, Promise<{ run: { id: string }; insertedRowCount: number; rowErrors: unknown[] }>>();
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
    // ...and a click that arrives while the first one is STILL being created (both passed the check below
    // before either run existed -- two runs, audit 2026-10-27) waits for it and gets the same run.
    const uploadKey = `${clientId}\n${file.originalname}\n${file.size}`;
    const inFlight = uploadsInFlight.get(uploadKey);
    if (inFlight) {
      const first = await inFlight.catch(() => null);
      if (first) {
        res.status(200).json({ run: first.run, insertedRowCount: first.insertedRowCount, rowErrors: [] });
        return;
      }
    }

    const recentDuplicate = await prisma.rankingRun.findFirst({
      where: { clientId, sourceFilename: file.originalname, createdAt: { gte: new Date(Date.now() - 10_000) } },
      orderBy: { createdAt: "desc" },
    });
    if (recentDuplicate) {
      res.status(200).json({ run: recentDuplicate, insertedRowCount: recentDuplicate.totalRows, rowErrors: [] });
      return;
    }

    const creating = (async () => {
      const { run, insertedRowCount, rowErrors } = await ingestExcelRun({
        clientId,
        sourceFilename: file.originalname,
        // A placeholder INSIDE the uploads folder, replaced below once we know run.id. It used to be the
        // uploaded file's own name: if saving then failed, deleting the run deleted a file of that name
        // from the server's working folder (audit 2026-10-27).
        sourceFilePath: path.join(UPLOADS_DIR, 'not-saved-yet.xlsx'),
        fileBuffer: file.buffer,
      });

      await mkdir(UPLOADS_DIR, { recursive: true });
      const storedPath = path.join(UPLOADS_DIR, `${run.id}.xlsx`);
      await writeFile(storedPath, file.buffer);
      await prisma.rankingRun.update({ where: { id: run.id }, data: { sourceFilePath: storedPath } });
      return { run: { ...run, sourceFilePath: storedPath }, insertedRowCount, rowErrors };
    })();
    uploadsInFlight.set(uploadKey, creating);

    try {
      res.status(201).json(await creating);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      uploadsInFlight.delete(uploadKey);
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
        // Rows already "Completed" with a rank are kept as they are and NOT checked again -- the page
        // warns, so last period's downloaded Excel isn't mistaken for fresh ranks (the user's choice, 2026-10-27).
        alreadyRankedCount: (rows as { status: string }[]).filter((r) => r.status === 'COMPLETED').length,
        rowErrorCount: rowErrors.length,
        rowErrors: rowErrors.slice(0, 5),
        detectedColumns: Object.values(COLUMN_HEADERS),
        fileSizeBytes: file.size,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Live DataForSEO without its login: refused up front -- a started run used to hang on its first keyword.
  const cantCheckRankings = (res: import('express').Response) => {
    if (callDataForSeo !== callDataForSeoLive || hasDataForSeoCredentials()) return false;
    res.status(503).json({ error: MISSING_CREDENTIALS_MESSAGE });
    return true;
  };

  router.post('/:id/start', expensiveActionRateLimit, async (req, res) => {
    if (!(await findOwnedRunOrRespond(req, res, req.params.id as string, { requireActive: true }))) return;
    if (cantCheckRankings(res)) return;
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
      // 409 only when the run is in the wrong state; a database failure is a real error, not a "conflict".
      if (!(err instanceof InvalidRunTransitionError)) throw err;
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // "Rerun failed": re-checks only this run's FAILED keywords, in place
  // (rerunFailedRows), then processes them exactly like /start. The
  // downloaded Excel is built from the rows on demand, so it picks up the
  // new results automatically. Refused once a report exists for the run --
  // its comparison and PDF were built from the current ranks.
  router.post('/:id/rerun-failed', expensiveActionRateLimit, async (req, res) => {
    const runId = req.params.id as string;
    if (!(await findOwnedRunOrRespond(req, res, runId, { requireActive: true }))) return;
    if (await prisma.rankingReport.findFirst({ where: { runId }, select: { id: true } })) {
      res.status(409).json({ error: 'This run already has a report. Rerun failed keywords before uploading the verified Excel.' });
      return;
    }
    if (cantCheckRankings(res)) return;
    try {
      const { run, resetCount } = await rerunFailedRows(runId);
      processRun(run.id, callDataForSeo).catch((err) => {
        console.error(`processRun failed for run ${run.id} (rerun failed):`, err);
      });
      res.json({ ...run, resetCount });
    } catch (err) {
      if (err instanceof InvalidRunTransitionError) {
        res.status(409).json({ error: 'Only a finished run with failed keywords can be rerun.' });
        return;
      }
      throw err;
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

  router.delete('/:id', async (req, res) => {
    const run = await findOwnedRunOrRespond(req, res, req.params.id, { requireActive: true });
    if (!run) return;
    if (run.status === 'PROCESSING') {
      res.status(409).json({ error: 'A run cannot be deleted while it is processing.' });
      return;
    }

    // Reports whose SUBJECT is this run (RankingReport.runId, the
    // "ReportRun" relation) have no independent existence once the run
    // they report on is gone -- deleted along with it, artifacts included.
    // This is intentionally different from a report that merely used this
    // run as a historical COMPARISON for a different (still-existing) run
    // -- see the previousRunId detach below, which leaves those reports and
    // their own run completely untouched.
    // That includes SENT reports and their send history -- the user's
    // decision (2026-10-27, after the audit asked): deleting a run removes everything from it.
    const dependentReports = await prisma.rankingReport.findMany({ where: { runId: run.id } });

    await prisma.$transaction(async (tx) => {
      // Detach reports that only reference this run as their historical
      // comparison (RankingReport.previousRunId, the "ReportPreviousRun"
      // relation) -- those reports belong to a different run and must
      // survive; only the now-gone comparison reference is cleared, same
      // principle as never touching a client's saved baseline files.
      await tx.rankingReport.updateMany({ where: { previousRunId: run.id }, data: { previousRunId: null } });

      await tx.rankingReport.deleteMany({ where: { runId: run.id } });
      await tx.rankingRow.updateMany({ where: { runId: run.id }, data: { lastAttemptId: null } });
      await tx.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: run.id } } });
      await tx.rankingRow.deleteMany({ where: { runId: run.id } });
      await tx.rankingRun.delete({ where: { id: run.id } });
    });

    await removeOwnFile(run.sourceFilePath);
    if (run.resultFilePath) await removeOwnFile(run.resultFilePath);
    for (const report of dependentReports) {
      if (report.clientPdfPath) await removeOwnFile(report.clientPdfPath);
      if (report.customPdfPath) await removeOwnFile(report.customPdfPath);
      await deleteExtraAttachmentFiles(report.id, report.extraAttachments);
    }
    res.status(204).send();
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
    res.attachment(filename); // encodes any name (a "–" or non-English letters used to make this a 500)
    res.send(updatedBuffer);
  });

  // The new workflow's single entry point: upload the manually-verified
  // Excel (the same template "Download Excel" produced) and the backend
  // automatically compares it against the client's previous verified Excel,
  // builds the PDF, and drafts the email -- no separate "Generate
  // Analysis"/"Build Report" click required. See processVerifiedExcelUpload
  // for the full pipeline.
  router.post('/:id/verified-excel', expensiveActionRateLimit, upload.single('file'), async (req, res) => {
    const run = await findOwnedRunOrRespond(req, res, req.params.id as string, { requireActive: true });
    if (!run) return;
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file is required' });
      return;
    }
    if (!looksLikeXlsx(file.buffer)) {
      res.status(400).json({ error: 'File does not look like a valid .xlsx workbook.' });
      return;
    }

    try {
      // "Continue" on the dashboard's re-send warning -- sent as a multipart field alongside the file.
      const confirmResend = req.body?.confirmResend === 'true';
      const result = await processVerifiedExcelUpload(run.id, file.buffer, file.originalname, req.authUser!.email, { confirmResend });
      switch (result.outcome) {
        case 'RUN_NOT_FOUND':
          res.status(404).json({ error: 'Run not found' });
          return;
        case 'RUN_NOT_COMPLETED':
          res.status(409).json({ error: 'Run is not completed yet -- fetch rankings before uploading a verified Excel.' });
          return;
        case 'DUPLICATE_REPORT':
          // Only reachable if two first-time uploads for the same run race each other.
          res.status(409).json({ code: 'DUPLICATE_REPORT', error: 'Another upload for this run is being processed. Refresh and try again.', existingReportId: result.existingReportId });
          return;
        case 'REPORT_LOCKED':
        case 'RESEND_CONFIRMATION_REQUIRED':
        case 'BASELINE_IN_USE': {
          const { status, body } = describeRegenerationBlock(result);
          res.status(status).json(body);
          return;
        }
        case 'NO_ROWS_PARSED':
          res.status(422).json({ error: 'No keyword rows could be read from this file.' });
          return;
        case 'UNMATCHED_ROWS':
          res.status(422).json({
            error: "This file doesn't match this run's exported Excel -- some keywords/rows couldn't be matched.",
            unmatchedKeywords: result.unmatchedKeywords,
          });
          return;
        case 'INVALID_ROWS': {
          const shown = result.problems.slice(0, 8).join('; ');
          const more = result.problems.length > 8 ? ` (and ${result.problems.length - 8} more)` : '';
          res.status(422).json({ error: `Nothing was changed -- fix these rows and upload again: ${shown}${more}`, problems: result.problems });
          return;
        }
        case 'SUCCESS':
          res.status(result.regenerated ? 200 : 201).json(describeReportGeneration(result));
          return;
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
