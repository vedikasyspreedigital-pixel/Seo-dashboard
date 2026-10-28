import { prisma } from '../db/client.js';
import { recoverOrphanedRow } from '../statemachine/rowTransitions.js';
import { processRun, type CallDataForSeoFn } from './processRun.js';

/**
 * Called once at server startup, before the server starts accepting
 * requests. Any RankingRun still PROCESSING at boot has no live processRun
 * behind it -- whatever process was working on it is gone (crash, OOM kill,
 * manual restart, deploy). Left alone it would sit PROCESSING forever with
 * nothing to resume it (there is no "resume a stuck run" API endpoint, only
 * /start, which only accepts UPLOADED runs, and a PROCESSING run can't be
 * deleted).
 *
 * Covers every way a run can be left behind, not just a row caught
 * mid-call: a row stuck PROCESSING, rows still PENDING/ERROR_RETRY (the
 * process died during a retry backoff or between rows -- found in the
 * 2026-10-27 audit), or every row finished but the run never marked
 * complete. Only runs that are still PROCESSING count -- a CANCELLED run is
 * never silently resumed.
 *
 * Resets each stale PROCESSING row (see recoverOrphanedRow -- never
 * re-charges the retry budget for an interrupted attempt, since we don't
 * know whether it would have succeeded), then resumes each run's
 * processRun fire-and-forget, same pattern as a fresh /start call.
 * processRun only picks up PENDING/ERROR_RETRY rows, so COMPLETED rows are
 * never sent to DataForSEO again, and it finishes the run's status itself.
 *
 * `onlyClientId` limits the sweep to one client (tests share one database).
 */
export async function recoverStaleProcessingRows(callDataForSeo: CallDataForSeoFn, { onlyClientId }: { onlyClientId?: string } = {}): Promise<void> {
  const runs = await prisma.rankingRun.findMany({
    where: { status: 'PROCESSING', ...(onlyClientId ? { clientId: onlyClientId } : {}) },
    select: { id: true },
  });
  if (runs.length === 0) return;

  let staleRowCount = 0;
  for (const run of runs) {
    const staleRows = await prisma.rankingRow.findMany({ where: { runId: run.id, status: 'PROCESSING' }, select: { id: true } });
    for (const row of staleRows) await recoverOrphanedRow(row.id);
    staleRowCount += staleRows.length;
  }

  console.log(`Resuming ${runs.length} interrupted run(s) (${staleRowCount} stale PROCESSING row(s) reset).`);
  for (const run of runs) {
    processRun(run.id, callDataForSeo).catch((err) => {
      console.error(`processRun failed while auto-resuming recovered run ${run.id}:`, err);
    });
  }
}
