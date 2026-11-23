import { prisma } from '../db/client.js';
import { InvalidRunTransitionError } from './errors.js';

export const RUN_TRANSITIONS = {
  UPLOADED: ['QUEUED', 'PROCESSING', 'CANCELLED'],
  // Run queue (2026-11-23): waiting its turn -- backend/worker/runQueue.ts starts it.
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'],
  COMPLETED: [],
  // Only via rerunFailedRows: re-checks just the FAILED keywords, in place.
  COMPLETED_WITH_ERRORS: ['PROCESSING'],
  CANCELLED: [],
};

export function isValidRunTransition(from, to) {
  return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * UPLOADED -> QUEUED ("Start run" since 2026-11-23): the run waits its turn in the shared queue.
 * `urgent` puts it in front of every non-urgent run (`reason`/`by` say who and why).
 */
/** @param {string} runId @param {{ urgent?: boolean, reason?: string | null, by?: string | null }} [options] */
export async function queueRun(runId, { urgent = false, reason = null, by = null } = {}) {
  const now = new Date();
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: 'UPLOADED' },
    data: { status: 'QUEUED', queuedAt: now, ...(urgent ? { urgent: true, urgentReason: reason, urgentBy: by, urgentAt: now } : {}) },
  });
  if (count === 0) throw new InvalidRunTransitionError(runId, 'queue (UPLOADED -> QUEUED)');
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
}

/** QUEUED -> PROCESSING: the queue's turn came (runQueue.ts). */
export async function startQueuedRun(runId) {
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: 'QUEUED' },
    data: { status: 'PROCESSING', startedAt: new Date() },
  });
  if (count === 0) throw new InvalidRunTransitionError(runId, 'start queued (QUEUED -> PROCESSING)');
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
}

/** A QUEUED run jumps to the front of the queue (still waits for whatever is running now to finish). */
/** @param {string} runId @param {{ reason: string | null, by?: string | null }} options */
export async function markRunUrgent(runId, { reason, by = null }) {
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: 'QUEUED', urgent: false },
    data: { urgent: true, urgentReason: reason, urgentBy: by, urgentAt: new Date() },
  });
  if (count === 0) throw new InvalidRunTransitionError(runId, 'make urgent (only a queued, not-yet-urgent run)');
  return prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
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

/** UPLOADED | QUEUED | PROCESSING -> CANCELLED. */
export async function cancelRun(runId) {
  const { count } = await prisma.rankingRun.updateMany({
    where: { id: runId, status: { in: ['UPLOADED', 'QUEUED', 'PROCESSING'] } },
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
