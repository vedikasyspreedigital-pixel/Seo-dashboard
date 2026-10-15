import { prisma } from '../db/client.js';
import { InvalidRunTransitionError } from './errors.js';

export const RUN_TRANSITIONS = {
  UPLOADED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'],
  COMPLETED: [],
  // Only via rerunFailedRows: re-checks just the FAILED keywords, in place.
  COMPLETED_WITH_ERRORS: ['PROCESSING'],
  CANCELLED: [],
};

export function isValidRunTransition(from, to) {
  return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

/** UPLOADED -> PROCESSING. */
export async function startRun(runId) {
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: 'UPLOADED' },
    data: { status: 'PROCESSING', startedAt: new Date() },
  });
  if (count === 0) throw new InvalidRunTransitionError(runId, 'start (UPLOADED -> PROCESSING)');
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
}

/**
 * COMPLETED_WITH_ERRORS -> PROCESSING, re-checking ONLY the run's FAILED
 * rows in place ("Rerun failed" on the Run Detail page). Those rows go back
 * to PENDING with a fresh retry budget and their failed result cleared;
 * COMPLETED rows (ranks and "Not in 100") are untouched and never sent to
 * DataForSEO again. Attempt history is kept -- recordAttemptAndApply numbers
 * new attempts after the old ones. One transaction, and the run update is
 * conditional on its status, so a double click can't reopen it twice.
 * Resolves to { run, resetCount }.
 */
export async function rerunFailedRows(runId) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.rankingRun.updateMany({
      where: { id: runId, status: 'COMPLETED_WITH_ERRORS' },
      data: { status: 'PROCESSING', completedAt: null },
    });
    if (count === 0) throw new InvalidRunTransitionError(runId, 'rerun failed rows (COMPLETED_WITH_ERRORS -> PROCESSING)');
    const { count: resetCount } = await tx.rankingRow.updateMany({
      where: { runId, status: 'FAILED' },
      data: { status: 'PENDING', retryCount: 0, lastErrorMessage: null, rankValue: null, rankDisplay: null, rankingUrl: null },
    });
    if (resetCount === 0) throw new InvalidRunTransitionError(runId, 'rerun failed rows (no FAILED rows)');
    const run = await tx.rankingRun.findUniqueOrThrow({ where: { id: runId } });
    return { run, resetCount };
  });
}

/** UPLOADED | PROCESSING -> CANCELLED. */
export async function cancelRun(runId) {
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: { in: ['UPLOADED', 'PROCESSING'] } },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (count === 0) throw new InvalidRunTransitionError(runId, 'cancel');
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
}

/**
 * Re-evaluates the locked completion rule: a PROCESSING run is done once no
 * row remains in PENDING/PROCESSING/ERROR_RETRY. Resolves to
 * COMPLETED_WITH_ERRORS if any row ended FAILED, otherwise COMPLETED.
 * No-op (returns null) if the run isn't currently PROCESSING, or rows are
 * still in flight -- safe to call after every row transition.
 */
export async function recomputeRunCompletion(runId) {
  const counts = await prisma.rankingRow.groupBy({
    by: ['status'],
    where: { runId },
    _count: { _all: true },
  });
  const countFor = (status) => counts.find((c) => c.status === status)?._count._all ?? 0;
  const nonTerminal = countFor('PENDING') + countFor('PROCESSING') + countFor('ERROR_RETRY');
  if (nonTerminal > 0) return null;

  const targetStatus = countFor('FAILED') > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';

  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: 'PROCESSING' },
    data: { status: targetStatus, completedAt: new Date() },
  });
  if (count === 0) return null; // already completed/cancelled by something else
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
}
