import { prisma } from '../db/client.js';
import { buildDataForSeoRequest } from '../dataforseo/buildRequest.js';
import { recordAttemptAndApply } from '../dataforseo/recordAttemptAndApply.js';
import { dequeueRow } from '../statemachine/rowTransitions.js';
import { recomputeRunCompletion } from '../statemachine/runTransitions.js';
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

/**
 * Processes every PENDING/ERROR_RETRY row of a run sequentially: dequeue ->
 * call DataForSEO (real or injected mock) -> record+apply the response ->
 * once the loop finishes, recompute the run's final status.
 *
 * Reuses the exact same tested modules as scripts/run-real-batch.mjs --
 * no ranking/mapping/state-machine logic is duplicated or changed here.
 */
export async function processRun(runId: string, callDataForSeo: CallDataForSeoFn): Promise<void> {
  const rows: RankingRowRecord[] = await prisma.rankingRow.findMany({
    where: { runId, status: { in: ['PENDING', 'ERROR_RETRY'] } },
  });

  for (const row of rows) {
    await dequeueRow(row.id);
    const requestPayload = buildDataForSeoRequest(row);
    const { httpStatus, body, transportError } = await callDataForSeo(requestPayload);

    await recordAttemptAndApply(row.id, {
      requestPayload,
      httpStatus,
      responseBody: body,
      transportError,
    });
  }

  await recomputeRunCompletion(runId);
}
