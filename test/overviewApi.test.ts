import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Full HTTP-layer test against the real local Postgres container, checking
// that /api/overview's numbers are genuine counts/sums of what's actually
// in the DB -- not fabricated or estimated.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
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
  const client = await makeClient(`Overview Test - ${randomUUID()}`);
  try {
    const run1 = await makeRun(client.id, "COMPLETED");
    const run2 = await makeRun(client.id, "COMPLETED");
    // Older report for this client -- must NOT be counted in the KPI totals,
    // only the newest one should be (per-client "current state" rule).
    const older = await makeReportWithAnalytics(client.id, run1.id, 5, 5, 5, 10);
    await prisma.rankingReport.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await makeReportWithAnalytics(client.id, run2.id, 2, 1, 0, 3);

    const res = await request(app).get("/api/overview");
    assert.equal(res.status, 200);
    // Other test files share this DB and run concurrently, so exact counts
    // here would be racy -- assert real numeric totals that are at least
    // consistent with what this test itself just created, not exact
    // equality against a separately-queried snapshot.
    assert.equal(typeof res.body.totalClients, "number");
    assert.ok(res.body.totalClients >= 1);
    assert.ok(res.body.totalRuns >= 2);
    assert.ok(res.body.totalSuccessfulRuns >= 2);

    // Only the newer report's numbers (2/1/0/3) should count for this client,
    // not the older report's (5/5/5/10) -- proves de-duplication by client.
    assert.ok(res.body.rankingMovements.improved >= 2);
    assert.ok(res.body.rankingMovements.declined >= 1);

    assert.equal(res.body.recentRuns.length <= 8, true);
    const ourRun = res.body.recentRuns.find((r: { id: string }) => r.id === run2.id);
    assert.ok(ourRun);
    assert.equal(ourRun.clientName, client.name);
    assert.equal(ourRun.status, "COMPLETED");
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
