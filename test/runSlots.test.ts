import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { nextOccurrence, tickRunSlots } from "../backend/scheduling/runSlots.js";
import { queueRun } from "../backend/statemachine/runTransitions.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Run slots (2026-11-23): teams book times; "Start all" queues each client's run (fresh upload, else a copy of
// the last keyword list); the reminder fires at the slot's time; repeating slots move on.

const okCall: CallDataForSeoFn = async (payload) => ({
  httpStatus: 200,
  body: { status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ keyword: payload.keyword, items: [] }] }] },
});

let seo: AuthFixture;
let adv: AuthFixture;
test.before(async () => {
  seo = await createAuthenticatedSession();
  adv = await createAuthenticatedSession();
});
test.after(async () => {
  await prisma.runSlot.deleteMany({ where: { workspaceId: { in: [seo.workspace.id, adv.workspace.id] } } });
  await seo.cleanup();
  await adv.cleanup();
  await prisma.$disconnect();
});

const tmp = mkdtempSync(path.join(os.tmpdir(), "slots-"));

async function client(workspaceId: string, name: string) {
  return prisma.client.create({ data: { name: `${name} ${randomUUID().slice(0, 6)}`, workspaceId, reportTypeConfirmed: true } });
}

async function run(clientId: string, status: "UPLOADED" | "COMPLETED", keywords = ["alpha", "beta"]) {
  const file = path.join(tmp, `${randomUUID()}.xlsx`);
  writeFileSync(file, "fake excel");
  const r = await prisma.rankingRun.create({ data: { clientId, sourceFilename: "kw.xlsx", sourceFilePath: file, totalRows: keywords.length, status } });
  for (const [i, keyword] of keywords.entries()) {
    await prisma.rankingRow.create({
      data: {
        runId: r.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*example.*", locationName: "India", seDomain: "google.co.in", languageName: "English",
        status: status === "COMPLETED" ? "COMPLETED" : "PENDING", rankValue: status === "COMPLETED" ? 5 : null, rankDisplay: status === "COMPLETED" ? "5" : null,
      },
    });
  }
  return r;
}

async function cleanupClients(ids: string[]) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId: { in: ids } }, select: { id: true } });
  const rowIds = (await prisma.rankingRow.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id);
  await prisma.rankingRow.updateMany({ where: { id: { in: rowIds } }, data: { lastAttemptId: null } });
  await prisma.rankingRowAttempt.deleteMany({ where: { rankingRowId: { in: rowIds } } });
  await prisma.rankingRow.deleteMany({ where: { id: { in: rowIds } } });
  await prisma.notification.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.rankingRun.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
}

test("booking: both teams see each other's slots (without client names), clashes are flagged, bad input refused", async () => {
  const app = createApp(okCall, "mock");
  const seoApi = authedRequest(app, seo.cookieHeader);
  const advApi = authedRequest(app, adv.cookieHeader);
  const friday10 = new Date(Date.now() + 3 * 24 * 3600_000);
  const a = await seoApi.post("/api/run-slots").send({ workspaceId: seo.workspace.id, startsAt: friday10.toISOString(), durationMinutes: 180, repeatDays: 15, note: "SEO batch" });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.clashes, []);
  // Advanced SEO books 2 hours later -- overlaps SEO's 3-hour window.
  const b = await advApi.post("/api/run-slots").send({ workspaceId: adv.workspace.id, startsAt: new Date(friday10.getTime() + 2 * 3600_000).toISOString(), durationMinutes: 120 });
  assert.equal(b.status, 201);
  assert.equal(b.body.clashes.length, 1);
  assert.equal(b.body.clashes[0].workspaceName, seo.workspace.name);

  const seen = (await advApi.get("/api/run-slots")).body.filter((s: { id: string }) => [a.body.slot.id, b.body.slot.id].includes(s.id));
  const seoSlot = seen.find((s: { id: string }) => s.id === a.body.slot.id);
  assert.deepEqual([seoSlot.own, seoSlot.note, seoSlot.clients, seoSlot.state], [false, null, null, "upcoming"]);

  assert.equal((await seoApi.post("/api/run-slots").send({ workspaceId: seo.workspace.id, startsAt: "2020-01-01T10:00:00Z" })).status, 400);
  assert.equal((await seoApi.post("/api/run-slots").send({ workspaceId: seo.workspace.id, startsAt: friday10.toISOString(), repeatDays: 3 })).status, 400);
  assert.equal((await seoApi.post("/api/run-slots").send({ workspaceId: adv.workspace.id, startsAt: friday10.toISOString() })).status, 404);
  assert.equal((await advApi.delete(`/api/run-slots/${a.body.slot.id}`)).status, 404); // not theirs
  assert.equal((await seoApi.delete(`/api/run-slots/${a.body.slot.id}`)).status, 204);
});

test("Start all: fresh upload used, else last keywords copied (reset to check); busy and file-less clients skipped; once only", async () => {
  const app = createApp(okCall, "mock");
  const api = authedRequest(app, seo.cookieHeader);
  const withHistory = await client(seo.workspace.id, "History");
  const withUpload = await client(seo.workspace.id, "Upload");
  const noFile = await client(seo.workspace.id, "Nofile");
  const busy = await client(seo.workspace.id, "Busy");
  const ids = [withHistory.id, withUpload.id, noFile.id, busy.id];
  try {
    const old = await run(withHistory.id, "COMPLETED", ["one", "two", "three"]);
    const upload = await run(withUpload.id, "UPLOADED");
    await queueRun((await run(busy.id, "UPLOADED")).id); // waiting in the queue, never started here

    const slot = (await api.post("/api/run-slots").send({ workspaceId: seo.workspace.id, startsAt: new Date().toISOString(), clientIds: ids })).body.slot;
    const started = await api.post(`/api/run-slots/${slot.id}/start`);
    assert.equal(started.status, 200);
    const by = (id: string) => started.body.queued.find((q: { clientId: string }) => q.clientId === id);
    assert.equal(by(withUpload.id).runId, upload.id);
    assert.equal(by(withUpload.id).reused, false);
    const copy = by(withHistory.id);
    assert.equal(copy.reused, true);
    assert.equal(copy.keywords, 3);
    assert.notEqual(copy.runId, old.id);
    const copied = await prisma.rankingRun.findUniqueOrThrow({ where: { id: copy.runId } });
    assert.ok(existsSync(copied.sourceFilePath), "the Excel was copied for the new run");
    const skipped = Object.fromEntries(started.body.skipped.map((s: { clientId: string; reason: string }) => [s.clientId, s.reason]));
    assert.match(skipped[noFile.id], /no keyword file/);
    assert.match(skipped[busy.id], /already has a run/);

    assert.equal((await api.post(`/api/run-slots/${slot.id}/start`)).status, 409); // once per slot
    const view = (await api.get("/api/run-slots")).body.find((s: { id: string }) => s.id === slot.id);
    assert.equal(view.state, "started");
    assert.equal(view.startedBy, seo.user.email);
  } finally {
    await cleanupClients(ids);
  }
});

test("the reminder goes out once at the slot's time; a repeating slot moves to its next date after its window", async () => {
  const start = new Date(Date.now() - 10 * 60_000);
  const slot = await prisma.runSlot.create({ data: { workspaceId: adv.workspace.id, startsAt: start, durationMinutes: 60, repeatDays: 7 } });
  await tickRunSlots(new Date(), [adv.workspace.id]);
  await tickRunSlots(new Date(), [adv.workspace.id]);
  assert.equal(await prisma.notification.count({ where: { workspaceId: adv.workspace.id, type: "RUN_SLOT_DUE" } }), 1);

  await tickRunSlots(new Date(start.getTime() + 2 * 3600_000), [adv.workspace.id]); // window over
  const moved = await prisma.runSlot.findUniqueOrThrow({ where: { id: slot.id } });
  assert.equal(moved.startsAt.getTime(), start.getTime() + 7 * 24 * 3600_000);
  assert.equal(moved.notifiedAt, null);
  assert.equal(nextOccurrence(new Date("2026-11-27T04:30:00Z"), 15, new Date("2026-12-20T00:00:00Z")).toISOString(), "2026-12-27T04:30:00.000Z");
});

test("Start all when the last keyword file is gone: the Excel is rebuilt from the saved keywords", async () => {
  const app = createApp(okCall, "mock");
  const api = authedRequest(app, seo.cookieHeader);
  const c = await client(seo.workspace.id, "Lostfile");
  try {
    const old = await run(c.id, "COMPLETED", ["gamma", "delta"]);
    unlinkSync(old.sourceFilePath);
    const slot = (await api.post("/api/run-slots").send({ workspaceId: seo.workspace.id, startsAt: new Date().toISOString(), clientIds: [c.id] })).body.slot;
    const started = (await api.post(`/api/run-slots/${slot.id}/start`)).body;
    assert.equal(started.skipped.length, 0);
    const copy = await prisma.rankingRun.findUniqueOrThrow({ where: { id: started.queued[0].runId } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(copy.sourceFilePath);
    const ws = wb.worksheets[0];
    assert.deepEqual([ws.getCell("A1").value, ws.getCell("A2").value, ws.getCell("A3").value, ws.getCell("H2").value], ["Keywords", "gamma", "delta", "Pending"]);
  } finally {
    await prisma.runSlot.deleteMany({ where: { workspaceId: seo.workspace.id } });
    await cleanupClients([c.id]);
  }
});
