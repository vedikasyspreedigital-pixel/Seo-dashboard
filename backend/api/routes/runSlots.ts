import { Router } from "express";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import type { CallDataForSeoFn } from "../../worker/processRun.js";
import { REPEAT_CHOICES, RunSlotError, findClashes, slotClients, startRunSlot } from "../../scheduling/runSlots.js";

// Run slots (2026-11-23) -- see backend/scheduling/runSlots.ts.
//   GET    /api/run-slots              every team's slots (the other team's without notes/client names)
//   POST   /api/run-slots              book one { workspaceId, startsAt, durationMinutes, repeatDays, clientIds, note }
//   DELETE /api/run-slots/:id
//   POST   /api/run-slots/:id/start    "Start all": each client's run into the run queue

const DURATIONS = [60, 120, 180, 240, 360];

type SlotRow = Awaited<ReturnType<typeof prisma.runSlot.findMany<{ include: { workspace: { select: { name: true } } } }>>>[number];

function slotState(slot: SlotRow, now: Date) {
  const end = new Date(slot.startsAt.getTime() + slot.durationMinutes * 60_000);
  if (slot.startedForSlotAt?.getTime() === slot.startsAt.getTime()) return "started";
  if (now < slot.startsAt) return "upcoming";
  if (now < end) return "open";
  return "missed";
}

export function createRunSlotsRouter(callDataForSeo: CallDataForSeoFn) {
  const router = Router();
  router.use(requireAuth);

  async function ownSlotOrRespond(req: import("express").Request, res: import("express").Response) {
    const slot = await prisma.runSlot.findUnique({ where: { id: req.params.id as string } });
    if (!slot || !req.authUser!.workspaceIds.includes(slot.workspaceId)) {
      res.status(404).json({ error: "Run slot not found" });
      return null;
    }
    return slot;
  }

  router.get("/", async (req, res) => {
    const now = new Date();
    const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const slots = await prisma.runSlot.findMany({
      where: { OR: [{ startsAt: { gte: since } }, { repeatDays: { not: null } }] },
      orderBy: { startsAt: "asc" },
      include: { workspace: { select: { name: true } } },
    });
    const out = [];
    for (const s of slots) {
      const own = req.authUser!.workspaceIds.includes(s.workspaceId);
      const clients = own ? await slotClients(s) : [];
      out.push({
        id: s.id,
        workspaceId: s.workspaceId,
        workspaceName: s.workspace.name,
        own,
        startsAt: s.startsAt,
        durationMinutes: s.durationMinutes,
        repeatDays: s.repeatDays,
        state: slotState(s, now),
        allClients: s.clientIds.length === 0,
        clients: own ? clients : null,
        clientCount: own ? clients.length : s.clientIds.length || null,
        note: own ? s.note : null,
        createdBy: own ? s.createdBy : null,
        startedAt: s.startedForSlotAt?.getTime() === s.startsAt.getTime() ? s.startedAt : null,
        startedBy: own && s.startedForSlotAt?.getTime() === s.startsAt.getTime() ? s.startedBy : null,
        lastResult: own ? s.lastResult : null,
      });
    }
    res.json(out);
  });

  router.post("/", async (req, res) => {
    const { workspaceId, startsAt, durationMinutes, repeatDays, clientIds, note } = req.body ?? {};
    if (typeof workspaceId !== "string" || !req.authUser!.workspaceIds.includes(workspaceId)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const start = typeof startsAt === "string" ? new Date(startsAt) : null;
    if (!start || Number.isNaN(start.getTime())) {
      res.status(400).json({ error: "Pick a date and time for the slot." });
      return;
    }
    if (start.getTime() < Date.now() - 5 * 60_000) {
      res.status(400).json({ error: "That time has already passed -- pick a time from now on." });
      return;
    }
    const minutes = Number(durationMinutes ?? 180);
    if (!DURATIONS.includes(minutes)) {
      res.status(400).json({ error: `Length must be one of ${DURATIONS.map((d) => d / 60).join(", ")} hours.` });
      return;
    }
    const repeat = repeatDays === null || repeatDays === undefined ? null : Number(repeatDays);
    if (!(REPEAT_CHOICES as readonly (number | null)[]).includes(repeat)) {
      res.status(400).json({ error: "Repeat must be once, every week (7) or every 15 days (15)." });
      return;
    }
    const ids: string[] = Array.isArray(clientIds) ? clientIds.filter((x: unknown): x is string => typeof x === "string") : [];
    if (ids.length) {
      const found = await prisma.client.count({ where: { id: { in: ids }, workspaceId } });
      if (found !== new Set(ids).size) {
        res.status(400).json({ error: "Some of the picked clients aren't in this team." });
        return;
      }
    }
    const slot = await prisma.runSlot.create({
      data: {
        workspaceId,
        startsAt: start,
        durationMinutes: minutes,
        repeatDays: repeat,
        clientIds: [...new Set(ids)],
        note: typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null,
        createdBy: req.authUser!.email,
      },
    });
    res.status(201).json({ slot, clashes: await findClashes(workspaceId, start, minutes, slot.id) });
  });

  /** Clash check before booking (the form shows it as you pick a time). */
  router.get("/clashes", async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? "");
    const start = new Date(String(req.query.startsAt ?? ""));
    const minutes = Number(req.query.durationMinutes ?? 180);
    if (!req.authUser!.workspaceIds.includes(workspaceId) || Number.isNaN(start.getTime()) || !DURATIONS.includes(minutes)) {
      res.json([]);
      return;
    }
    res.json(await findClashes(workspaceId, start, minutes));
  });

  router.delete("/:id", async (req, res) => {
    const slot = await ownSlotOrRespond(req, res);
    if (!slot) return;
    await prisma.runSlot.delete({ where: { id: slot.id } });
    res.status(204).send();
  });

  router.post("/:id/start", expensiveActionRateLimit, async (req, res) => {
    const slot = await ownSlotOrRespond(req, res);
    if (!slot) return;
    try {
      res.json(await startRunSlot(slot.id, { by: req.authUser!.email, call: callDataForSeo }));
    } catch (err) {
      if (!(err instanceof RunSlotError)) throw err;
      res.status(409).json({ error: err.message });
    }
  });

  return router;
}
