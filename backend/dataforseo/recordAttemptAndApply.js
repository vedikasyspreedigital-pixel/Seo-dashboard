import { prisma } from '../db/client.js';
import { completeRow, failRowAttempt } from '../statemachine/rowTransitions.js';
import { mapDataForSeoResponse } from './mapResponse.js';

/**
 * The full "after the HTTP call" pipeline for one row:
 *   1. map the raw response/transport-error into our internal shape
 *   2. persist the attempt (raw_response always saved, win or lose --
 *      this is what lets a later retry skip re-calling DataForSEO)
 *   3. apply the outcome to the row via the state machine
 *
 * Row must already be PROCESSING (i.e. dequeueRow was already called) --
 * that's enforced by completeRow/failRowAttempt themselves.
 *
 * @param {string} rowId
 * @param {{ requestPayload: object, transportError?: Error, httpStatus?: number, responseBody?: any }} input
 */
export async function recordAttemptAndApply(rowId, { requestPayload, transportError, httpStatus, responseBody }) {
  const mapped = mapDataForSeoResponse({ transportError, httpStatus, body: responseBody });

  const attemptNumber = (await prisma.rankingRowAttempt.count({ where: { rankingRowId: rowId } })) + 1;

  const attempt = await prisma.rankingRowAttempt.create({
    data: {
      rankingRowId: rowId,
      attemptNumber,
      requestPayload,
      httpStatus: httpStatus ?? null,
      dataforseoStatusCode: mapped.taskStatusCode,
      dataforseoStatusMessage: mapped.taskStatusMessage,
      rawResponse: responseBody ?? null,
      mappedRankValue: mapped.rankValue,
      mappedRankingUrl: mapped.rankingUrl,
      outcome: mapped.outcome,
      errorMessage: mapped.errorMessage,
    },
  });

  const row =
    mapped.outcome === 'SUCCESS'
      ? await completeRow(rowId, {
          rankValue: mapped.rankValue,
          rankDisplay: mapped.rankDisplay,
          rankingUrl: mapped.rankingUrl,
          attemptId: attempt.id,
        })
      : await failRowAttempt(rowId, {
          errorMessage: mapped.errorMessage,
          attemptId: attempt.id,
          forceFailed: mapped.retryable === false,
        });

  return { row, attempt, mapped };
}
