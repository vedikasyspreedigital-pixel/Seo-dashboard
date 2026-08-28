import { prisma } from '../db/client.js';
import { InvalidRunTransitionError } from './errors.js';

export const RUN_TRANSITIONS = {
  UPLOADED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'],
  COMPLETED: [],
  COMPLETED_WITH_ERRORS: [],
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
