import { prisma } from '../db/client.js';
import { buildDataForSeoRequest } from '../dataforseo/buildRequest.js';
import { recordAttemptAndApply } from '../dataforseo/recordAttemptAndApply.js';
import { dequeueRow } from '../statemachine/rowTransitions.js';
import { recomputeRunCompletion } from '../statemachine/runTransitions.js';
import { notifyRunCompletion } from '../notifications/createNotification.js';
import type { DataForSeoCallResult, DataForSeoRequestPayload } from '../dataforseo/client.js';

export type CallDataForSeoFn = (payload: DataForSeoRequestPayload) => Promise<DataForSeoCallResult>;

interface RankingRowRecord {
  id: string;
  keyword: string;
  targetUrl: string;
  locationName: string;
  seDomain: string;
  languageName: string;
}

// Small exponential backoff between retry attempts on the SAME row --
// deliberately kept low so a batch with a handful of retries doesn't grind
// to a halt waiting it out. Delay is based on the row's own retryCount
// right after a failed attempt (1 = just failed for the first time), so
// the wait before attempt 2 is BACKOFF_BASE_MS, before attempt 3 is
// BACKOFF_BASE_MS*2, etc., capped at BACKOFF_MAX_MS.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;

function backoffDelayMs(retryCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (retryCount - 1), BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processes every PENDING/ERROR_RETRY row of a run sequentially: dequeue ->
 * call DataForSEO (real or injected mock) -> record+apply the response. If
 * a row comes back ERROR_RETRY (a retryable failure with retries still
 * remaining -- see mapResponse.js's isRetryableDataForSeoStatusCode and
 * rowTransitions.js's failRowAttempt), it is retried again in place, after
 * a small backoff, until it reaches a terminal status (COMPLETED or
 * FAILED) -- never left behind in ERROR_RETRY for a human to notice and
 * manually re-trigger via a whole separate run.
 *
 * maxRetries/retryCount semantics are unchanged and unmoved from
 * rowTransitions.js: a row gets up to `maxRetries` TOTAL attempts
 * (confirmed from failRowAttempt's own guard, `retry_count + 1 >=
 * max_retries`), not maxRetries retries on top of an initial attempt.
 *
 * Still deliberately sequential (one row at a time, no concurrency) and
 * still exactly one processRun call per run started -- no new scheduler,
 * cron, or background architecture; the retry loop lives entirely inside
 * this existing function, and recomputeRunCompletion (called once at the
 * end, same as before) already returns null/no-ops if any row is still
 * non-terminal -- since every row above now only exits its inner loop once
 * terminal, that condition is never actually hit here anymore.
 *
 * Every attempt (initial or retry) still creates its own RankingRowAttempt
 * via recordAttemptAndApply, unchanged -- full attempt history is
 * preserved exactly as before, just with more rows in it per row.
 *
 * Reuses the exact same tested modules as scripts/run-real-batch.mjs --
 * no ranking/mapping/state-machine logic is duplicated or changed here.
 */
export async function processRun(runId: string, callDataForSeo: CallDataForSeoFn): Promise<void> {
  const rows: RankingRowRecord[] = await prisma.rankingRow.findMany({
    where: { runId, status: { in: ['PENDING', 'ERROR_RETRY'] } },
  });

  for (const row of rows) {
    // Loop until this row reaches a terminal status. Each iteration is the
    // same dequeue/call/record sequence as before -- dequeueRow accepts
    // either PENDING or ERROR_RETRY, so re-entering it after a retryable
    // failure (the row is now ERROR_RETRY) works unchanged.
    for (;;) {
      await dequeueRow(row.id);
      const requestPayload = buildDataForSeoRequest(row);
      const { httpStatus, body, transportError } = await callDataForSeo(requestPayload);

      const { row: updatedRow } = await recordAttemptAndApply(row.id, {
        requestPayload,
        httpStatus,
        responseBody: body,
        transportError,
      });

      if (updatedRow.status !== 'ERROR_RETRY') break; // COMPLETED or FAILED -- this row is done
      await sleep(backoffDelayMs(updatedRow.retryCount));
    }
  }

  const completedRun = await recomputeRunCompletion(runId);
  if (completedRun) await notifyRunCompletion(completedRun);
}
