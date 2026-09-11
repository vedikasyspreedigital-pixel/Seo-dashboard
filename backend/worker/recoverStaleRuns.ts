import { prisma } from '../db/client.js';
import { recoverOrphanedRow } from '../statemachine/rowTransitions.js';
import { processRun, type CallDataForSeoFn } from './processRun.js';

/**
 * Called once at server startup, before the server starts accepting
 * requests. Any RankingRow still marked PROCESSING at boot is, by
 * definition, orphaned: a fresh process has no in-flight DataForSEO call
 * matching it -- whatever process dequeued it is gone (crash, OOM kill,
 * manual restart, or a hung request that got killed along with the old
 * process). Left alone, that row -- and every row behind it in the same
 * run, since processRun is sequential -- would sit stuck forever with
 * nothing to resume it (there is no "resume a stuck run" API endpoint, only
 * /start, which only accepts UPLOADED runs).
 *
 * Only considers rows whose RUN is still PROCESSING -- a row could show
 * PROCESSING while its run was separately CANCELLED (cancelRun doesn't
 * touch row statuses), and that must never be silently resumed after a
 * restart; the run-status join excludes that case entirely.
 *
 * Resets each stale row (see recoverOrphanedRow -- never re-charges the
 * retry budget for an interrupted attempt, since we don't know whether it
 * would have succeeded) before returning, then resumes each affected run's
 * processRun fire-and-forget, same pattern as a fresh /start call -- so a
 * stuck run recovers automatically on the next boot, no manual DB surgery
 * or restart-and-hope required.
 */
export async function recoverStaleProcessingRows(callDataForSeo: CallDataForSeoFn): Promise<void> {
  const staleRows = await prisma.rankingRow.findMany({
    where: { status: 'PROCESSING', run: { status: 'PROCESSING' } },
    select: { id: true, runId: true },
  });
  if (staleRows.length === 0) return;

  const affectedRunIds = new Set<string>();
  for (const row of staleRows) {
    await recoverOrphanedRow(row.id);
    affectedRunIds.add(row.runId);
  }

  console.log(`Recovered ${staleRows.length} stale PROCESSING row(s) across ${affectedRunIds.size} run(s) -- resuming automatically.`);
  for (const runId of affectedRunIds) {
    processRun(runId, callDataForSeo).catch((err) => {
      console.error(`processRun failed while auto-resuming recovered run ${runId}:`, err);
    });
  }
}
