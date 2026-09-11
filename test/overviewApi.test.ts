import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession } from "./helpers/auth.js";

// Full HTTP-layer test against the real local Postgres container, checking
// that /api/overview's numbers are genuine counts/sums of what's actually
// in the DB -- not fabricated or estimated.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function makeClient(name: string, workspaceId: string) {
  return prisma.client.create({ data: { name, workspaceId } });
}

async function makeRun(clientId: string, status: "UPLOADED" | "COMPLETED" | "CANCELLED" = "COMPLETED") {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "overview-test.xlsx",
      sourceFilePath: "local-test/overview-test.xlsx",
      totalRows: 3,
      status,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });
}

async function makeReportWithAnalytics(clientId: string, runId: string, improved: number, declined: number, unchanged: number, totalKeywords: number) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.REPORT_READY,
      analyticsJson: {
        totals: { totalKeywords, averageRank: 5, top3Count: 0, top10Count: 0, notIn100Count: 0 },
        movements: {
          improved: Array.from({ length: improved }, (_, i) => ({ keyword: `k-imp-${i}` })),
          declined: Array.from({ length: declined }, (_, i) => ({ keyword: `k-dec-${i}` })),
          unchanged: Array.from({ length: unchanged }, (_, i) => ({ keyword: `k-unc-${i}` })),
          newlyTracked: [],
        },
      },
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("GET /api/overview: totals are real counts, and KPI movements use only the latest report per client", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await makeClient(`Overview Test - ${randomUUID()}`, auth.workspace.id);
  try {
    const run1 = await makeRun(client.id, "COMPLETED");
    const run2 = await makeRun(client.id, "COMPLETED");
    // Older report for this client -- must NOT be counted in the KPI totals,
    // only the newest one should be (per-client "current state" rule).
    const older = await makeReportWithAnalytics(client.id, run1.id, 5, 5, 5, 10);
    await prisma.rankingReport.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await makeReportWithAnalytics(client.id, run2.id, 2, 1, 0, 3);

    const res = await request(app).get(`/api/overview?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    // Scoped to a workspace created fresh for this test alone, so unlike
    // before, other concurrent test files sharing this DB can't pollute
    // these numbers -- exact equality is now safe, not just "at least".
    assert.equal(res.body.totalClients, 1);
    assert.equal(res.body.totalRuns, 2);
    assert.equal(res.body.totalSuccessfulRuns, 2);

    // Only the newer report's numbers (2/1/0/3) should count for this client,
    // not the older report's (5/5/5/10) -- proves de-duplication by client.
    assert.equal(res.body.rankingMovements.improved, 2);
    assert.equal(res.body.rankingMovements.declined, 1);

    assert.equal(res.body.recentRuns.length, 2);
    const ourRun = res.body.recentRuns.find((r: { id: string }) => r.id === run2.id);
    assert.ok(ourRun);
    assert.equal(ourRun.clientName, client.name);
    assert.equal(ourRun.status, "COMPLETED");
  } finally {
    await cleanupClient(client.id);
    await auth.cleanup();
  }
});

test("GET /api/overview?clientId=: scopes every aggregate to one client, not the whole workspace -- the fix for the client-switching stale-data bug", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const clientA = await makeClient(`Overview Scope Test A - ${randomUUID()}`, auth.workspace.id);
  const clientB = await makeClient(`Overview Scope Test B - ${randomUUID()}`, auth.workspace.id);
  try {
    const runA = await makeRun(clientA.id, "COMPLETED");
    const runB = await makeRun(clientB.id, "COMPLETED");
    await makeReportWithAnalytics(clientA.id, runA.id, 3, 0, 0, 3);
    await makeReportWithAnalytics(clientB.id, runB.id, 0, 7, 0, 7);

    const resA = await request(app).get(`/api/overview?workspaceId=${auth.workspace.id}&clientId=${clientA.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(resA.status, 200);
    assert.equal(resA.body.totalRuns, 1, "must only count client A's run, not both clients'");
    assert.equal(resA.body.rankingMovements.improved, 3);
    assert.equal(resA.body.rankingMovements.declined, 0);
    assert.equal(resA.body.recentRuns.length, 1);
    assert.equal(resA.body.recentRuns[0].id, runA.id);

    const resB = await request(app).get(`/api/overview?workspaceId=${auth.workspace.id}&clientId=${clientB.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(resB.body.totalRuns, 1, "must only count client B's run");
    assert.equal(resB.body.rankingMovements.declined, 7);
    assert.equal(resB.body.recentRuns[0].id, runB.id);

    // No clientId at all -- still the original workspace-wide behavior.
    const resAll = await request(app).get(`/api/overview?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(resAll.body.totalRuns, 2, "omitting clientId must still aggregate the whole workspace");
  } finally {
    await cleanupClient(clientA.id);
    await cleanupClient(clientB.id);
    await auth.cleanup();
  }
});

test("GET /api/overview?clientId=: a foreign client is rejected (404), not silently ignored or leaking data", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `other-${randomUUID()}`, name: "Other" } });
  const foreignClient = await makeClient(`Foreign Client - ${randomUUID()}`, otherWorkspace.id);
  try {
    const res = await request(app).get(`/api/overview?workspaceId=${auth.workspace.id}&clientId=${foreignClient.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 404);
  } finally {
    await prisma.client.delete({ where: { id: foreignClient.id } });
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("GET /api/overview requires authentication", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).get("/api/overview?workspaceId=whatever");
  assert.equal(res.status, 401);
});

test.after(async () => {
  await prisma.$disconnect();
});
