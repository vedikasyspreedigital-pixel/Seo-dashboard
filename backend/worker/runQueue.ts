import { prisma } from '../db/client.js';
import { InvalidRunTransitionError } from '../statemachine/errors.js';
import { startQueuedRun } from '../statemachine/runTransitions.js';
import { assignEngine } from '../dataforseo/engine.js';
import { wakeStandardQueue } from './standardQueue.js';
import { processRun, type CallDataForSeoFn } from './processRun.js';

/**
 * Run queue (2026-11-23). SEO and Advanced SEO share one backend and one rank-checking account, so "Start run"
 * no longer fires every run at once: the run goes QUEUED and this starts them in turn, RUN_QUEUE_CONCURRENCY at a
 * time (default 1; 0 = no limit). Order: urgent runs first (earliest marked first), then by when they were queued.
 * An urgent run never interrupts a run that's already checking -- it's simply next.
 *
 * The queue lives in the database (status QUEUED), so it survives a restart: startRunQueue() at boot picks up
 * where it left off, and a timer re-checks every 30 seconds in case a wake-up was missed.
 * Standard-engine runs (DataForSEO's own queue) don't hold a slot -- they're handed to standardQueue.ts.
 */

const callByRun = new Map<string, CallDataForSeoFn>();
let defaultCall: CallDataForSeoFn | null = null;

export function runQueueConcurrency(): number {
  const raw = process.env.RUN_QUEUE_CONCURRENCY;
  const n = raw === undefined || raw.trim() === '' ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** Which rank call a queued run uses when its turn comes (the app that queued it). */
export function rememberRunCall(runId: string, call: CallDataForSeoFn) {
  callByRun.set(runId, call);
}

/** Waiting first-in-line order: urgent (earliest marked first), then earliest queued. */
export const QUEUE_ORDER = [{ urgent: 'desc' as const }, { urgentAt: 'asc' as const }, { queuedAt: 'asc' as const }, { createdAt: 'asc' as const }];

async function dispatchOnce(): Promise<void> {
  const limit = runQueueConcurrency();
  for (;;) {
    if (limit > 0) {
      const active = await prisma.rankingRun.count({ where: { status: 'PROCESSING', engine: { not: 'standard' } } });
      if (active >= limit) return;
    }
    // Before startRunQueue (boot), only runs queued by this process are known -- tests rely on that too.
    const where = defaultCall ? { status: 'QUEUED' as const } : { status: 'QUEUED' as const, id: { in: [...callByRun.keys()] } };
    const next = await prisma.rankingRun.findFirst({ where, orderBy: QUEUE_ORDER, select: { id: true } });
    if (!next) return;
    const call = callByRun.get(next.id) ?? defaultCall;
    if (!call) return;
    try {
      await startQueuedRun(next.id);
    } catch (err) {
      if (err instanceof InvalidRunTransitionError) continue; // cancelled or started meanwhile
      throw err;
    }
    callByRun.delete(next.id);
    const engine = await assignEngine(next.id);
    if (engine === 'standard') {
      wakeStandardQueue();
      continue;
    }
    processRun(next.id, call)
      .catch((err) => console.error(`processRun failed for queued run ${next.id}:`, err))
      .finally(() => void wakeRunQueue());
  }
}

let dispatching: Promise<void> | null = null;
let again = false;

/** Starts whatever the queue has room for. Safe to call any time, from anywhere; calls never overlap. */
export function wakeRunQueue(): Promise<void> {
  if (dispatching) {
    again = true;
    return dispatching;
  }
  dispatching = (async () => {
    do {
      again = false;
      await dispatchOnce();
    } while (again);
  })()
    .catch((err) => console.error('[runQueue] dispatch failed:', err))
    .finally(() => {
      dispatching = null;
    });
  return dispatching;
}

let timer: NodeJS.Timeout | null = null;

/** At boot: the call queued runs use after a restart, then carry on with the queue. */
export function startRunQueue(call: CallDataForSeoFn) {
  defaultCall = call;
  if (!timer) {
    timer = setInterval(() => void wakeRunQueue(), 30_000);
    timer.unref();
  }
  void wakeRunQueue();
}

export interface QueueEntry {
  runId: string;
  status: 'PROCESSING' | 'QUEUED';
  /** 1 = next to start; null while it's checking. */
  position: number | null;
  workspaceId: string | null;
  workspaceName: string | null;
  clientId: string;
  /** Only for the caller's own workspaces -- the other team sees "a run". */
  clientName: string | null;
  urgent: boolean;
  urgentReason: string | null;
  urgentBy: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  totalRows: number;
  doneRows: number;
}

/** Everything checking or waiting, across both teams, in queue order. */
export async function listRunQueue(viewerWorkspaceIds: string[]): Promise<{ concurrency: number; entries: QueueEntry[] }> {
  const include = { client: { select: { name: true, workspaceId: true, workspace: { select: { name: true } } } } } as const;
  const processing = await prisma.rankingRun.findMany({ where: { status: 'PROCESSING', engine: { not: 'standard' } }, orderBy: { startedAt: 'asc' }, include });
  const queued = await prisma.rankingRun.findMany({ where: { status: 'QUEUED' }, orderBy: QUEUE_ORDER, include });
  const ids = [...processing, ...queued].map((r) => r.id);
  const done = ids.length
    ? await prisma.rankingRow.groupBy({ by: ['runId'], where: { runId: { in: ids }, status: { in: ['COMPLETED', 'FAILED'] } }, _count: { _all: true } })
    : [];
  const doneBy = new Map(done.map((d) => [d.runId, d._count._all]));
  const entry = (r: (typeof queued)[number], position: number | null): QueueEntry => {
    const own = !!r.client.workspaceId && viewerWorkspaceIds.includes(r.client.workspaceId);
    return {
      runId: r.id,
      status: r.status as 'PROCESSING' | 'QUEUED',
      position,
      workspaceId: r.client.workspaceId,
      workspaceName: r.client.workspace?.name ?? null,
      clientId: r.clientId,
      clientName: own ? r.client.name : null,
      urgent: r.urgent,
      urgentReason: own ? r.urgentReason : null,
      urgentBy: own ? r.urgentBy : null,
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      totalRows: r.totalRows,
      doneRows: doneBy.get(r.id) ?? 0,
    };
  };
  return { concurrency: runQueueConcurrency(), entries: [...processing.map((r) => entry(r, null)), ...queued.map((r, i) => entry(r, i + 1))] };
}

/** 1 = next to start; null when the run isn't waiting. */
export async function queuePositionOf(runId: string): Promise<number | null> {
  const queued = await prisma.rankingRun.findMany({ where: { status: 'QUEUED' }, orderBy: QUEUE_ORDER, select: { id: true } });
  const i = queued.findIndex((r) => r.id === runId);
  return i === -1 ? null : i + 1;
}
