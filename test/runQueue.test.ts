import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { wakeRunQueue } from "../backend/worker/runQueue.js";
import { queueRun, markRunUrgent } from "../backend/statemachine/runTransitions.js";
import { InvalidRunTransitionError } from "../backend/statemachine/errors.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Run queue (2026-11-23): "Start run" queues the run; one checks at a time; an urgent run goes next (never
// interrupting the one checking); the other team is told why. This file runs one at a time.
process.env.RUN_QUEUE_CONCURRENCY = "1";

const slowCall: CallDataForSeoFn = async (payload) => {
  await new Promise((r) => setTimeout(r, 150));
  return {
    httpStatus: 200,
    body: {
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ keyword: payload.keyword, items: [{ type: "organic", rank_group: 4, rank_absolute: 4, url: "https://example.com/" }] }] }],
    },
  };
};

let seo: AuthFixture;
let adv: AuthFixture;
test.before(async () => {
  seo = await createAuthenticatedSession();
  adv = await createAuthenticatedSession();
});
test.after(async () => {
  await seo.cleanup();
  await adv.cleanup();
  await prisma.$disconnect();
});

async function makeClient(workspaceId: string, label: string) {
  return prisma.client.create({ data: { name: `Queue ${label} ${randomUUID().slice(0, 6)}`, workspaceId, reportTypeConfirmed: true } });
}

async function makeRun(clientId: string, name: string) {
  const run = await prisma.rankingRun.create({ data: { clientId, sourceFilename: `${name}.xlsx`, sourceFilePath: "x", totalRows: 2 } });
  for (const [i, keyword] of ["kw one", "kw two"].entries()) {
    await prisma.rankingRow.create({
      data: { runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*example.*", locationName: "India", seDomain: "google.co.in", languageName: "English" },
    });
  }
  return run;
}

async function cleanup(clientIds: string[]) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
  const rowIds = (await prisma.rankingRow.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id);
  await prisma.rankingRowAttempt.deleteMany({ where: { rankingRowId: { in: rowIds } } });
  await prisma.rankingRow.deleteMany({ where: { id: { in: rowIds } } });
  await prisma.notification.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.rankingRun.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
}

/** Wakes the queue until these runs are done (other test files may briefly hold the one slot). */
async function waitDone(runIds: string[]) {
  const until = Date.now() + 30_000;
  for (;;) {
    const left = await prisma.rankingRun.count({ where: { id: { in: runIds }, status: { notIn: ["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"] } } });
    if (left === 0) return;
    if (Date.now() > until) throw new Error("runs never finished");
    await wakeRunQueue();
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("Start queues runs and they check one at a time; an urgent run goes next and the other team is told why", async () => {
  const app = createApp(slowCall, "mock");
  const api = authedRequest(app, seo.cookieHeader);
  const seoClient = await makeClient(seo.workspace.id, "seo");
  const advClient = await makeClient(adv.workspace.id, "adv");
  try {
    const a = await makeRun(seoClient.id, "a");
    const b = await makeRun(seoClient.id, "b");
    const c = await makeRun(seoClient.id, "c");
    // The other team's run waiting in the queue (never started here: this process doesn't know how to check it).
    const other = await makeRun(advClient.id, "other");
    await queueRun(other.id);

    assert.equal((await api.post(`/api/runs/${a.id}/start`)).status, 200);
    const startB = await api.post(`/api/runs/${b.id}/start`);
    assert.equal(startB.body.status, "QUEUED");
    assert.equal((await api.post(`/api/runs/${c.id}/start`).send({ urgent: true, reason: "" })).status, 400);
    const startC = await api.post(`/api/runs/${c.id}/start`).send({ urgent: true, reason: "Client call at 3" });
    assert.equal(startC.body.urgent, true);

    // The queue view: own runs named, the other team's shown without the client name.
    const queue = (await api.get("/api/runs/queue")).body;
    const mine = queue.entries.filter((e: { clientId: string }) => e.clientId === seoClient.id);
    assert.ok(mine.every((e: { clientName: string | null }) => e.clientName === seoClient.name));
    const theirs = queue.entries.find((e: { runId: string }) => e.runId === other.id);
    assert.equal(theirs.clientName, null);
    assert.equal(theirs.workspaceName, adv.workspace.name);
    const waiting = queue.entries.filter((e: { status: string; clientId: string }) => e.status === "QUEUED" && e.clientId === seoClient.id).map((e: { runId: string }) => e.runId);
    assert.ok(waiting.indexOf(c.id) < waiting.indexOf(b.id) || !waiting.includes(b.id), "urgent C waits in front of B");

    // The other team got the reason.
    const told = await prisma.notification.findFirst({ where: { workspaceId: adv.workspace.id, type: "RUN_MADE_URGENT" } });
    assert.match(told!.message, /Client call at 3/);

    await waitDone([a.id, b.id, c.id]);
    const done = await prisma.rankingRun.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const started = (id: string) => done.find((r) => r.id === id)!.startedAt!.getTime();
    assert.ok(started(c.id) < started(b.id), "urgent C started before B");
    assert.ok(started(b.id) >= Math.max(started(a.id), started(c.id)), "B, the plain one queued last, went last");
    assert.ok(done.every((r) => r.status === "COMPLETED"));
    // Never two at once: each started after the previous one finished.
    const byStart = [...done].sort((x, y) => x.startedAt!.getTime() - y.startedAt!.getTime());
    for (let i = 1; i < byStart.length; i++) assert.ok(byStart[i].startedAt! >= byStart[i - 1].completedAt!, "one at a time");
  } finally {
    await cleanup([seoClient.id, advClient.id]);
  }
});

test("only a waiting run can be made urgent; a queued run can be cancelled", async () => {
  const app = createApp(slowCall, "mock");
  const api = authedRequest(app, seo.cookieHeader);
  const client = await makeClient(seo.workspace.id, "misc");
  try {
    const run = await makeRun(client.id, "x");
    await assert.rejects(markRunUrgent(run.id, { reason: "now" }), InvalidRunTransitionError); // not queued yet
    await queueRun(run.id);
    assert.equal((await api.post(`/api/runs/${run.id}/urgent`).send({ reason: "x" })).status, 400);
    const urgent = await api.post(`/api/runs/${run.id}/urgent`).send({ reason: "Client waiting" });
    assert.equal(urgent.status, 200);
    assert.equal(urgent.body.urgentBy, seo.user.email);
    assert.equal((await api.post(`/api/runs/${run.id}/urgent`).send({ reason: "again" })).status, 409);
    const cancelled = await api.post(`/api/runs/${run.id}/cancel`);
    assert.equal(cancelled.body.status, "CANCELLED");
  } finally {
    await cleanup([client.id]);
  }
});

// Found on the local walkthrough (2026-11-27): "Rerun failed" started straight away, so it checked at the same
// time as another run (two Serper runs at once). It now waits in the queue like any start.
test("Rerun failed while another run is checking waits in the queue, then runs after it", async () => {
  const app = createApp(slowCall, "mock");
  const api = authedRequest(app, seo.cookieHeader);
  const client = await makeClient(seo.workspace.id, "rerun");
  try {
    const busy = await makeRun(client.id, "busy");
    const failed = await makeRun(client.id, "failed");
    await prisma.rankingRun.update({ where: { id: failed.id }, data: { status: "COMPLETED_WITH_ERRORS", startedAt: new Date(Date.now() - 60_000), completedAt: new Date() } });
    await prisma.rankingRow.updateMany({ where: { runId: failed.id, keyword: "kw one" }, data: { status: "COMPLETED", rankDisplay: "4", rankValue: 4 } });
    await prisma.rankingRow.updateMany({ where: { runId: failed.id, keyword: "kw two" }, data: { status: "FAILED", retryCount: 3 } });

    assert.equal((await api.post(`/api/runs/${busy.id}/start`)).body.status, "PROCESSING");
    const rerun = await api.post(`/api/runs/${failed.id}/rerun-failed`);
    assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
    assert.equal(rerun.body.status, "QUEUED", "waits for the run that's checking");
    assert.equal(rerun.body.resetCount, 1);
    assert.ok(rerun.body.queuePosition >= 1);

    await waitDone([busy.id, failed.id]);
    const [b, f] = await Promise.all([prisma.rankingRun.findUniqueOrThrow({ where: { id: busy.id } }), prisma.rankingRun.findUniqueOrThrow({ where: { id: failed.id } })]);
    assert.ok(f.startedAt! >= b.completedAt!, "the rerun started only after the other run finished");
    assert.equal(f.status, "COMPLETED");
  } finally {
    await cleanup([client.id]);
  }
});
