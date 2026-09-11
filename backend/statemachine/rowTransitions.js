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

/**
 * PROCESSING -> ERROR_RETRY (if a real attempt was already recorded) or
 * PENDING (if it was dequeued for its very first attempt and never even
 * got that far) -- for a row found orphaned at server startup (see
 * backend/worker/recoverStaleRuns.ts): the process that dequeued it is
 * gone, so it can never itself transition this row again. Deliberately
 * does NOT increment retry_count or touch last_error_message -- unlike
 * failRowAttempt, this isn't a failed attempt, it's an interrupted one; we
 * genuinely don't know whether it would have succeeded, so it isn't
 * charged against the retry budget.
 */
export async function recoverOrphanedRow(rowId) {
  const row = await prisma.rankingRow.findUnique({ where: { id: rowId } });
  if (!row || row.status !== 'PROCESSING') return row; // already handled by someone else, or gone
  const targetStatus = row.retryCount > 0 ? 'ERROR_RETRY' : 'PENDING';
  const { count } = await prisma.rankingRow.updateMany({
    where: { id: rowId, status: 'PROCESSING' },
    data: { status: targetStatus },
  });
  if (count === 0) return prisma.rankingRow.findUniqueOrThrow({ where: { id: rowId } }); // raced with something else -- fine, just report current state
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
