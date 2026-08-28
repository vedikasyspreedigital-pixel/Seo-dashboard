import { prisma } from '../db/client.js';
import { InvalidRowTransitionError } from './errors.js';

// PENDING ──▶ PROCESSING ──▶ COMPLETED           (terminal)
// ERROR_RETRY ──▶ PROCESSING ──▶ ERROR_RETRY      (retry_count++, retries remain)
//                            └─▶ FAILED           (terminal, retries exhausted)
export const ROW_TRANSITIONS = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['COMPLETED', 'ERROR_RETRY', 'FAILED'],
  ERROR_RETRY: ['PROCESSING'],
  COMPLETED: [],
  FAILED: [],
};

export function isValidRowTransition(from, to) {
  return (ROW_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * PENDING | ERROR_RETRY -> PROCESSING.
 * Implemented as a conditional UPDATE (status must still match), so two
 * concurrent callers racing the same row can never both "win" -- Postgres
 * serializes the UPDATEs and the second one matches zero rows.
 */
export async function dequeueRow(rowId) {
  const { count } = await prisma.rankingRow.updateMany({
    where: { id: rowId, status: { in: ['PENDING', 'ERROR_RETRY'] } },
    data: { status: 'PROCESSING' },
  });
  if (count === 0) throw new InvalidRowTransitionError(rowId, 'dequeue (PENDING/ERROR_RETRY -> PROCESSING)');
  return prisma.rankingRow.findUniqueOrThrow({ where: { id: rowId } });
}

/** PROCESSING -> COMPLETED. Rejected if the row isn't currently PROCESSING. */
export async function completeRow(rowId, { rankValue = null, rankDisplay = null, rankingUrl = null, attemptId = null }) {
  const { count } = await prisma.rankingRow.updateMany({
    where: { id: rowId, status: 'PROCESSING' },
    data: {
      status: 'COMPLETED',
      rankValue,
      rankDisplay,
      rankingUrl,
      lastErrorMessage: null,
      ...(attemptId ? { lastAttemptId: attemptId } : {}),
    },
  });
  if (count === 0) throw new InvalidRowTransitionError(rowId, 'complete (PROCESSING -> COMPLETED)');
  return prisma.rankingRow.findUniqueOrThrow({ where: { id: rowId } });
}

/**
 * PROCESSING -> ERROR_RETRY (retry_count+1 < max_retries)
 *            -> FAILED       (retry_count+1 >= max_retries, OR forceFailed
 *                             is set for a non-retryable error -- no point
 *                             burning the remaining retry budget on a
 *                             permanent failure like a bad location_name)
 *
 * One atomic UPDATE statement: the retry-count increment and the resulting
 * status are computed from the same consistent read of the row, so two
 * concurrent failures on the same row can't double-increment retry_count
 * or disagree on the resulting status.
 */
export async function failRowAttempt(rowId, { errorMessage, attemptId = null, forceFailed = false }) {
  const rows = await prisma.$queryRaw`
    UPDATE ranking_rows
    SET status = CASE WHEN ${forceFailed} OR retry_count + 1 >= max_retries THEN 'FAILED'::"RowStatus" ELSE 'ERROR_RETRY'::"RowStatus" END,
        retry_count = retry_count + 1,
        last_error_message = ${errorMessage},
        last_attempt_id = COALESCE(${attemptId}, last_attempt_id),
        updated_at = now()
    WHERE id = ${rowId} AND status = 'PROCESSING'
    RETURNING id
  `;
  if (rows.length === 0) throw new InvalidRowTransitionError(rowId, 'fail attempt (PROCESSING -> ERROR_RETRY/FAILED)');
  return prisma.rankingRow.findUniqueOrThrow({ where: { id: rowId } });
}
