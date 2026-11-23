import { copyFile, mkdir, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { COLUMN_HEADERS } from "../excel/mapping.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { queueRun } from "../statemachine/runTransitions.js";
import { rememberRunCall, wakeRunQueue } from "../worker/runQueue.js";
import { createNotification } from "../notifications/createNotification.js";
import type { CallDataForSeoFn } from "../worker/processRun.js";

/**
 * Run slots (2026-11-23) -- see the RunSlot model. "Start all" for a slot puts one run per client in the run
 * queue (backend/worker/runQueue.ts):
 *   - the client's freshly uploaded, not-yet-started run, when there is one (that's how the team swaps in a new
 *     keyword file before the slot), else
 *   - a copy of the client's last keyword list (its last run's rows and Excel), every keyword reset to be checked.
 * A client that already has a run waiting or checking is skipped, so nothing runs twice.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, "../../uploads");

export const REPEAT_CHOICES = [null, 7, 15] as const;

export interface SlotStartResult {
  queued: { clientId: string; clientName: string; runId: string; reused: boolean; keywords: number }[];
  skipped: { clientId: string; clientName: string; reason: string }[];
}

export class RunSlotError extends Error {}

/** The clients a slot covers right now: its picked ones, or every active ranking client of the team. */
export async function slotClients(slot: { workspaceId: string; clientIds: string[] }) {
  return prisma.client.findMany({
    where: {
      workspaceId: slot.workspaceId,
      kind: "ranking",
      isActive: true,
      archivedAt: null,
      ...(slot.clientIds.length ? { id: { in: slot.clientIds } } : {}),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/**
 * The keyword file rebuilt from saved rows -- for when the last run's Excel is gone from the server (cleaned up,
 * or a different laptop). Same columns as the team's template, each row on its original row number, so
 * "Download Excel" fills in the new ranks exactly as it would on the uploaded file.
 */
async function rebuildKeywordFile(rows: { sourceRowNumber: number; keyword: string; fullUrl: string | null; targetUrl: string; concatenate: string | null; locationName: string; seDomain: string; languageName: string }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const keys = ["keyword", "fullUrl", "targetUrl", "concatenate", "locationName", "seDomain", "languageName", "status", "rank", "rankingUrl"] as const;
  ws.getRow(1).values = keys.map((k) => COLUMN_HEADERS[k]);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.getRow(r.sourceRowNumber).values = [r.keyword, r.fullUrl ?? "", r.targetUrl, r.concatenate ?? "", r.locationName, r.seDomain, r.languageName, "Pending", "", ""];
  }
  ws.columns.forEach((c, i) => (c.width = i === 0 || i === 3 ? 40 : 18));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A new UPLOADED run with the same keywords as `source` (its Excel copied -- or rebuilt if it's gone -- so "Download Excel" works). */
async function copyRunForSlot(source: { id: string; clientId: string; sourceFilename: string; sourceFilePath: string }, by: string | null) {
  const rows = await prisma.rankingRow.findMany({ where: { runId: source.id }, orderBy: { sourceRowNumber: "asc" } });
  if (rows.length === 0) throw new RunSlotError("its last run has no keywords");
  return prisma.$transaction(
    async (tx) => {
      const run = await tx.rankingRun.create({
        data: { clientId: source.clientId, sourceFilename: source.sourceFilename, sourceFilePath: path.join(UPLOADS_DIR, "not-saved-yet.xlsx"), totalRows: rows.length, createdBy: by, status: "UPLOADED" },
      });
      const data = rows.map((r) => ({
        runId: run.id,
        rowUid: r.rowUid,
        sourceRowNumber: r.sourceRowNumber,
        keyword: r.keyword,
        fullUrl: r.fullUrl,
        targetUrl: r.targetUrl,
        concatenate: r.concatenate,
        locationName: r.locationName,
        seDomain: r.seDomain,
        languageName: r.languageName,
        status: "PENDING" as const,
      }));
      for (let i = 0; i < data.length; i += 1000) await tx.rankingRow.createMany({ data: data.slice(i, i + 1000) });
      await mkdir(UPLOADS_DIR, { recursive: true });
      const stored = path.join(UPLOADS_DIR, `${run.id}.xlsx`);
      if (existsSync(source.sourceFilePath)) await copyFile(source.sourceFilePath, stored);
      else await writeFile(stored, await rebuildKeywordFile(rows));
      return tx.rankingRun.update({ where: { id: run.id }, data: { sourceFilePath: stored } });
    },
    { timeout: 60_000 },
  );
}

/** "Start all": one run per client into the run queue. Refused when this occurrence was already started. */
export async function startRunSlot(slotId: string, opts: { by: string | null; call: CallDataForSeoFn; now?: Date }): Promise<SlotStartResult> {
  const now = opts.now ?? new Date();
  const slot = await prisma.runSlot.findUniqueOrThrow({ where: { id: slotId } });
  // Claim this occurrence first, so a double click can't queue everything twice.
  const { count } = await prisma.runSlot.updateMany({
    where: { id: slotId, OR: [{ startedForSlotAt: null }, { startedForSlotAt: { not: slot.startsAt } }] },
    data: { startedForSlotAt: slot.startsAt, startedAt: now, startedBy: opts.by },
  });
  if (count === 0) throw new RunSlotError("This slot was already started.");

  const result: SlotStartResult = { queued: [], skipped: [] };
  for (const client of await slotClients(slot)) {
    try {
      const busy = await prisma.rankingRun.findFirst({ where: { clientId: client.id, status: { in: ["QUEUED", "PROCESSING"] } }, select: { id: true } });
      if (busy) {
        result.skipped.push({ clientId: client.id, clientName: client.name, reason: "already has a run waiting or checking" });
        continue;
      }
      const fresh = await prisma.rankingRun.findFirst({ where: { clientId: client.id, status: "UPLOADED" }, orderBy: { createdAt: "desc" } });
      let runId: string;
      let reused: boolean;
      if (fresh) {
        runId = fresh.id;
        reused = false;
      } else {
        const last = await prisma.rankingRun.findFirst({
          where: { clientId: client.id, status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"] } },
          orderBy: { createdAt: "desc" },
        });
        if (!last) {
          result.skipped.push({ clientId: client.id, clientName: client.name, reason: "no keyword file yet -- upload one in New Run" });
          continue;
        }
        runId = (await copyRunForSlot(last, opts.by)).id;
        reused = true;
      }
      const queued = await queueRun(runId, { by: opts.by });
      rememberRunCall(queued.id, opts.call);
      result.queued.push({ clientId: client.id, clientName: client.name, runId, reused, keywords: queued.totalRows });
    } catch (err) {
      result.skipped.push({ clientId: client.id, clientName: client.name, reason: err instanceof RunSlotError ? err.message : `couldn't start: ${(err as Error).message}` });
    }
  }
  await prisma.runSlot.update({ where: { id: slotId }, data: { lastResult: result as unknown as object } });
  await wakeRunQueue();
  return result;
}

/** The next start time at or after `after` for a repeating slot. */
export function nextOccurrence(startsAt: Date, repeatDays: number, after: Date): Date {
  const step = repeatDays * 24 * 60 * 60 * 1000;
  let t = startsAt.getTime();
  while (t <= after.getTime()) t += step;
  return new Date(t);
}

/**
 * Once a minute: the reminder for every slot whose time has come, and repeating slots move on to their next date
 * once their window is over. `onlyWorkspaceIds` limits it (tests share one database).
 */
export async function tickRunSlots(now = new Date(), onlyWorkspaceIds?: string[]) {
  const scope = onlyWorkspaceIds ? { workspaceId: { in: onlyWorkspaceIds } } : {};
  const due = await prisma.runSlot.findMany({ where: { ...scope, startsAt: { lte: now }, notifiedAt: null } });
  for (const slot of due) {
    const end = new Date(slot.startsAt.getTime() + slot.durationMinutes * 60_000);
    const started = slot.startedForSlotAt?.getTime() === slot.startsAt.getTime();
    // Only remind while the window is open and nobody has started it yet.
    if (now < end && !started) {
      const clients = await slotClients(slot);
      await createNotification({
        workspaceId: slot.workspaceId,
        type: "RUN_SLOT_DUE",
        message: `Your run slot has started: ${clients.length} client${clients.length === 1 ? "" : "s"} ready. Open Run slots and press Start all.`,
      });
    }
    await prisma.runSlot.update({ where: { id: slot.id }, data: { notifiedAt: now } });
  }
  const repeating = await prisma.runSlot.findMany({ where: { ...scope, repeatDays: { not: null }, startsAt: { lte: now } } });
  for (const slot of repeating) {
    const end = new Date(slot.startsAt.getTime() + slot.durationMinutes * 60_000);
    if (now < end) continue;
    await prisma.runSlot.update({ where: { id: slot.id }, data: { startsAt: nextOccurrence(slot.startsAt, slot.repeatDays!, now), notifiedAt: null } });
  }
}

let timer: NodeJS.Timeout | null = null;
export function startRunSlotTicker() {
  if (timer) return;
  const tick = () => tickRunSlots().catch((err) => console.error("[runSlots] tick failed:", err));
  void tick();
  timer = setInterval(tick, 60_000);
  timer.unref();
}

/** Other teams' slots whose window overlaps [start, start + minutes). */
export async function findClashes(workspaceId: string, startsAt: Date, durationMinutes: number, ignoreId?: string) {
  const end = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const others = await prisma.runSlot.findMany({
    where: { workspaceId: { not: workspaceId }, ...(ignoreId ? { id: { not: ignoreId } } : {}), startsAt: { lt: end } },
    include: { workspace: { select: { name: true } } },
  });
  return others
    .filter((o) => new Date(o.startsAt.getTime() + o.durationMinutes * 60_000) > startsAt)
    .map((o) => ({ slotId: o.id, workspaceName: o.workspace.name, startsAt: o.startsAt, durationMinutes: o.durationMinutes }));
}
