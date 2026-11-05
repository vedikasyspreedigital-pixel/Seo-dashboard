import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.js';
import { buildDataForSeoRequest } from '../dataforseo/buildRequest.js';
import { recordAttemptAndApply } from '../dataforseo/recordAttemptAndApply.js';
import { applyTargetFilter } from '../dataforseo/targetMatch.js';
import { MAX_TASKS_PER_POST, type StandardClient, type StandardTaskPayload } from '../dataforseo/standardClient.js';
import { dequeueRow, recoverOrphanedRow } from '../statemachine/rowTransitions.js';
import { InvalidRowTransitionError } from '../statemachine/errors.js';
import { recomputeRunCompletion } from '../statemachine/runTransitions.js';
import { notifyRunCompletion } from '../notifications/createNotification.js';

// The DataForSEO Standard (queue) worker -- the counterpart of processRun.ts
// for runs whose engine is "standard" (engine.ts). processRun calls Live
// one row at a time and waits for each answer; Standard is a queue, so this
// is split into two steps that run on a timer for the WHOLE server (one
// queue, not one loop per run -- 14 runs started together no longer mean
// 14 parallel calls):
//
//   submit:  due rows of every PROCESSING standard run -> dequeueRow
//            (PENDING/ERROR_RETRY -> PROCESSING) -> a dataforseo_tasks row
//            (POSTING) -> task_post in batches of up to 100, each tagged
//            with our task row id -> SUBMITTED with DataForSEO's task id.
//   collect: tasks_ready (+ a direct task_get for tasks waiting unusually
//            long) -> claim the task (SUBMITTED -> COLLECTING, one atomic
//            update, so a result is never applied twice -- not by two
//            ticks, not by two servers during a deploy) -> task_get ->
//            filter to the client's items (targetMatch.js) -> the SAME
//            recordAttemptAndApply/mapResponse as Live -> COLLECTED.
//
// Everything is in Postgres, so a restart or deploy loses nothing: the next
// tick carries on (see recoverStandardTasksOnStartup for the few states a
// crash can leave). Rows keep the Live state machine and retry budget: an
// attempt is recorded per try, and a retryable failure waits
// standardRetryDelayMs before it is posted again.

/** Wait before try 2 and try 3 of a row: spread over ~40 min, so a DataForSEO outage (30 Oct 2026: 235 rows of 50401 timeouts, all 3 tries within ~1 min) has time to clear. */
export const STANDARD_RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000];
/** A task still not listed by tasks_ready after this is checked directly with task_get. */
export const STALE_CHECK_AFTER_MS = 15 * 60_000;
/** ...at most this often per task. */
export const STALE_RECHECK_EVERY_MS = 5 * 60_000;
/** A task still queued after this is given up and the row retried (DataForSEO's own target is 45 min). */
export const LOST_AFTER_MS = 3 * 60 * 60_000;
/** How many batches one tick may post (100 tasks each). */
const MAX_BATCHES_PER_TICK = 10;
const QUEUED_STATUS_CODES = new Set([40601, 40602]); // "Task Handed." / "Task In Queue."
const GONE_STATUS_CODES = new Set([40401, 40403, 40105]); // not found / results expired / deleted

export function standardRetryDelayMs(retryCount: number): number {
  return STANDARD_RETRY_DELAYS_MS[Math.min(Math.max(retryCount, 1), STANDARD_RETRY_DELAYS_MS.length) - 1];
}

export function standardPriority(): 1 | 2 {
  return process.env.DATAFORSEO_STANDARD_PRIORITY === '2' ? 2 : 1;
}

/** The Live request for this row, minus `target` (Standard has none -- applied by targetMatch.js on the result), plus our tag and priority. */
export function buildStandardTask(row: Parameters<typeof buildDataForSeoRequest>[0], tag: string, priority: 1 | 2): StandardTaskPayload {
  const { target: _target, ...rest } = buildDataForSeoRequest(row);
  return { ...rest, tag, priority };
}

interface TickOptions {
  now?: () => Date;
}

/** Runs whose rows changed this tick -- their completion is re-evaluated once, at the end. */
async function finishTouchedRuns(runIds: Set<string>) {
  for (const runId of runIds) {
    const completed = await recomputeRunCompletion(runId);
    if (completed) await notifyRunCompletion(completed);
  }
}

// ---------------------------------------------------------------- submit

export async function submitDueRows(client: StandardClient, { now = () => new Date() }: TickOptions = {}): Promise<number> {
  const touchedRuns = new Set<string>();
  let submitted = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const posted = await submitOneBatch(client, now(), touchedRuns);
    submitted += posted;
    if (posted < MAX_TASKS_PER_POST) break;
  }
  await finishTouchedRuns(touchedRuns);
  return submitted;
}

async function submitOneBatch(client: StandardClient, now: Date, touchedRuns: Set<string>): Promise<number> {
  const candidates = await prisma.rankingRow.findMany({
    where: { status: { in: ['PENDING', 'ERROR_RETRY'] }, run: { status: 'PROCESSING', engine: 'standard' } },
    include: { lastAttempt: { select: { createdAt: true } } },
    orderBy: [{ run: { startedAt: 'asc' } }, { sourceRowNumber: 'asc' }],
    take: MAX_TASKS_PER_POST * 5,
  });
  const due = candidates
    .filter((row) => row.status === 'PENDING' || !row.lastAttempt || row.lastAttempt.createdAt.getTime() + standardRetryDelayMs(row.retryCount) <= now.getTime())
    .slice(0, MAX_TASKS_PER_POST);
  if (due.length === 0) return 0;

  const priority = standardPriority();
  const batch: { taskId: string; rowId: string; runId: string; payload: StandardTaskPayload }[] = [];
  for (const row of due) {
    try {
      await dequeueRow(row.id);
    } catch (err) {
      if (err instanceof InvalidRowTransitionError) continue; // someone else took it
      throw err;
    }
    const taskId = randomUUID();
    const payload = buildStandardTask(row, taskId, priority);
    await prisma.dataforseoTask.create({ data: { id: taskId, rankingRowId: row.id, runId: row.runId, requestPayload: payload as object } });
    batch.push({ taskId, rowId: row.id, runId: row.runId, payload });
  }
  if (batch.length === 0) return 0;

  const { httpStatus, body, transportError } = await client.postTasks(batch.map((b) => b.payload));
  const response = body as { status_code?: number; tasks?: { id?: string; status_code?: number; data?: { tag?: string } }[] } | undefined;

  // The whole call failed: nothing (or an unknown part) was queued. The tries are recorded and
  // retried later; if DataForSEO did take some, those results are ignored (ABANDONED) -- at worst
  // a few cents twice, never a rank applied twice.
  if (transportError || response?.status_code !== 20000 || !Array.isArray(response.tasks)) {
    for (const b of batch) {
      await prisma.dataforseoTask.update({ where: { id: b.taskId }, data: { status: 'ABANDONED', errorMessage: transportError?.message ?? `task_post answered ${response?.status_code ?? httpStatus}` } });
      await recordAttemptAndApply(b.rowId, { requestPayload: b.payload, transportError, httpStatus, responseBody: body });
      touchedRuns.add(b.runId);
    }
    return 0;
  }

  let accepted = 0;
  for (const [index, b] of batch.entries()) {
    const entry = response.tasks.find((t) => t.data?.tag === b.taskId) ?? response.tasks[index];
    if (entry?.status_code === 20100 && entry.id) {
      await prisma.dataforseoTask.update({ where: { id: b.taskId }, data: { status: 'SUBMITTED', dataforseoTaskId: entry.id, submittedAt: new Date() } });
      accepted++;
      continue;
    }
    // Refused at post time (e.g. 40501 "Invalid Field: 'location_name'."): recorded like a Live
    // answer with that status, so mapResponse decides retry vs FAILED exactly as before.
    await prisma.dataforseoTask.update({ where: { id: b.taskId }, data: { status: 'FAILED', errorMessage: `${entry?.status_code ?? 'no answer'}` } });
    await recordAttemptAndApply(b.rowId, { requestPayload: b.payload, httpStatus, responseBody: { status_code: 20000, tasks: [entry ?? {}] } });
    touchedRuns.add(b.runId);
  }
  return accepted;
}

// ---------------------------------------------------------------- collect

export async function collectFinished(client: StandardClient, { now = () => new Date() }: TickOptions = {}): Promise<number> {
  const waiting = await prisma.dataforseoTask.count({ where: { status: 'SUBMITTED' } });
  if (waiting === 0) return 0; // nothing of ours in the queue -- don't spend a tasks_ready call (20/min limit)

  const toCheck = new Set<string>();
  const ready = await client.tasksReady();
  const readyBody = ready.body as { status_code?: number; tasks?: { result?: { id?: string }[] | null }[] } | undefined;
  if (!ready.transportError && readyBody?.status_code === 20000) {
    for (const entry of readyBody.tasks ?? []) for (const item of entry.result ?? []) if (item?.id) toCheck.add(item.id);
  }

  // tasks_ready can miss a task (over 1000 ready, a failed call, a task finished as an error):
  // anything waiting unusually long is also checked directly -- task_get is free.
  const at = now();
  const stale = await prisma.dataforseoTask.findMany({
    where: {
      status: 'SUBMITTED',
      submittedAt: { lt: new Date(at.getTime() - STALE_CHECK_AFTER_MS) },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(at.getTime() - STALE_RECHECK_EVERY_MS) } }],
    },
    select: { dataforseoTaskId: true },
    take: 50,
  });
  for (const t of stale) if (t.dataforseoTaskId) toCheck.add(t.dataforseoTaskId);

  const touchedRuns = new Set<string>();
  let collected = 0;
  for (const dataforseoTaskId of toCheck) {
    if (await collectTask(client, dataforseoTaskId, at, touchedRuns)) collected++;
  }
  await finishTouchedRuns(touchedRuns);
  return collected;
}

async function collectTask(client: StandardClient, dataforseoTaskId: string, at: Date, touchedRuns: Set<string>): Promise<boolean> {
  const task = await prisma.dataforseoTask.findUnique({ where: { dataforseoTaskId } });
  if (!task) return false; // not ours (another tool on the same DataForSEO account), or long gone

  // Claim it: only one collector ever gets past this line for a task.
  const { count } = await prisma.dataforseoTask.updateMany({ where: { id: task.id, status: 'SUBMITTED' }, data: { status: 'COLLECTING', lastCheckedAt: at } });
  if (count === 0) return false;
  const release = () => prisma.dataforseoTask.update({ where: { id: task.id }, data: { status: 'SUBMITTED' } });

  const { httpStatus, body, transportError } = await client.taskGet(dataforseoTaskId);
  const response = body as { status_code?: number; tasks?: { status_code?: number; status_message?: string }[] } | undefined;
  const taskCode = response?.tasks?.[0]?.status_code;
  const waitedTooLong = task.submittedAt !== null && at.getTime() - task.submittedAt.getTime() > LOST_AFTER_MS;
  const notReady = !!transportError || response?.status_code !== 20000 || (taskCode !== undefined && QUEUED_STATUS_CODES.has(taskCode));

  if (notReady && !waitedTooLong) {
    await release(); // not ready yet, or a hiccup fetching it -- try again on a later tick
    return false;
  }

  const row = await prisma.rankingRow.findUnique({ where: { id: task.rankingRowId }, include: { run: { select: { status: true } } } });
  if (!row || row.status !== 'PROCESSING' || row.run.status !== 'PROCESSING') {
    // The run was cancelled (or the row moved on) while DataForSEO worked: the result is not applied.
    await prisma.dataforseoTask.update({ where: { id: task.id }, data: { status: 'ABANDONED', collectedAt: at, errorMessage: 'run no longer processing' } });
    if (row?.status === 'PROCESSING') await recoverOrphanedRow(row.id);
    return false;
  }

  if (notReady) {
    await prisma.dataforseoTask.update({ where: { id: task.id }, data: { status: 'ABANDONED', collectedAt: at, errorMessage: 'still not done after 3 hours' } });
    await recordAttemptAndApply(row.id, { requestPayload: task.requestPayload as object, transportError: new Error(`DataForSEO hadn't finished this search after ${LOST_AFTER_MS / 3_600_000} hours -- trying again.`) });
    touchedRuns.add(task.runId);
    return false;
  }

  if (taskCode !== undefined && GONE_STATUS_CODES.has(taskCode)) {
    await prisma.dataforseoTask.update({ where: { id: task.id }, data: { status: 'ABANDONED', collectedAt: at, errorMessage: `${taskCode} ${response?.tasks?.[0]?.status_message ?? ''}`.trim() } });
    await recordAttemptAndApply(row.id, { requestPayload: task.requestPayload as object, transportError: new Error(`DataForSEO no longer has this search (${taskCode}) -- trying again.`) });
    touchedRuns.add(task.runId);
    return false;
  }

  await recordAttemptAndApply(row.id, {
    requestPayload: task.requestPayload as object,
    httpStatus,
    responseBody: body,
    mappingBody: applyTargetFilter(body, row.targetUrl),
  });
  await prisma.dataforseoTask.update({ where: { id: task.id }, data: { status: 'COLLECTED', collectedAt: at } });
  touchedRuns.add(task.runId);
  return true;
}

// ---------------------------------------------------------------- restart recovery

/**
 * At startup, before the queue's first tick. A crash can leave:
 * - POSTING tasks: we don't know whether task_post went through. Given up
 *   (ABANDONED, any late result ignored) and the row reset without
 *   charging its retry budget -- at worst one search is paid twice.
 * - COLLECTING tasks: the result wasn't recorded. Back to SUBMITTED; it is
 *   still waiting at DataForSEO (results are kept 30 days).
 * - PROCESSING rows of a standard run with no task waiting at DataForSEO
 *   (crashed between dequeue and post): reset like Live's recovery.
 * Rows whose task is SUBMITTED are left alone -- DataForSEO is working on them.
 */
export async function recoverStandardTasksOnStartup(): Promise<void> {
  const posting = await prisma.dataforseoTask.findMany({ where: { status: 'POSTING' }, select: { id: true } });
  if (posting.length) {
    await prisma.dataforseoTask.updateMany({ where: { id: { in: posting.map((t) => t.id) } }, data: { status: 'ABANDONED', errorMessage: 'server restarted while posting' } });
  }
  const collecting = await prisma.dataforseoTask.updateMany({ where: { status: 'COLLECTING' }, data: { status: 'SUBMITTED' } });

  const orphans = await prisma.rankingRow.findMany({
    where: { status: 'PROCESSING', run: { status: 'PROCESSING', engine: 'standard' }, dataforseoTasks: { none: { status: 'SUBMITTED' } } },
    select: { id: true },
  });
  for (const row of orphans) await recoverOrphanedRow(row.id);

  const waiting = await prisma.dataforseoTask.count({ where: { status: 'SUBMITTED' } });
  if (posting.length || collecting.count || orphans.length || waiting) {
    console.log(`[standardQueue] startup: ${waiting} search(es) still at DataForSEO, ${collecting.count} collection(s) resumed, ${posting.length} unconfirmed post(s) given up, ${orphans.length} row(s) reset.`);
  }
}

// ---------------------------------------------------------------- timer

let wakeCurrent: (() => void) | null = null;

/** Called when a standard run is started or rerun, so it doesn't wait for the next timer tick. No-op if the queue isn't running (tests). */
export function wakeStandardQueue(): void {
  wakeCurrent?.();
}

/**
 * Starts the queue's timer: one tick = submit what's due, then collect what's
 * finished. Ticks never overlap; a failing tick is logged and the next one
 * tries again. `intervalMs` 30 s keeps tasks_ready at <= 2 calls/min (limit 20).
 */
export function startStandardQueue(client: StandardClient, { intervalMs = 30_000 }: { intervalMs?: number } = {}): { stop: () => void } {
  let running = false;
  let again = false;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await submitDueRows(client);
        await collectFinished(client);
      } while (again);
    } catch (err) {
      console.error('[standardQueue] tick failed (will retry on the next one):', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  wakeCurrent = () => void tick();
  void tick();
  return {
    stop: () => {
      clearInterval(timer);
      wakeCurrent = null;
    },
  };
}
