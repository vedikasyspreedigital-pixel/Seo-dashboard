import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Full HTTP-layer test against the real local Postgres container
// (localhost:5433). DataForSEO is mocked -- no real API calls here.
// runs.ts now requires auth -- most tests below just need to get past that
// gate (they aren't testing workspace-ownership), so they share one
// logged-in session via authedApp(). The two GET /api/clients tests below
// manage their own auth explicitly since they ARE testing workspace/auth
// behavior directly.

let sharedAuth: AuthFixture;
test.before(async () => {
  sharedAuth = await createAuthenticatedSession();
});

function authedApp(app: ReturnType<typeof createApp>) {
  return authedRequest(app, sharedAuth.cookieHeader);
}

async function buildTestWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(Object.values(COLUMN_HEADERS));
  sheet.addRow([
    "cash for cars perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "x",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ]);
  sheet.addRow([
    "sell my car perth",
    "cash-for-cars-perth.com.au",
    "*cash-for-cars-perth.*",
    "x",
    "Australia",
    "google.com.au",
    "English",
    "Pending",
    "",
    "",
  ]);
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const mockCallDataForSeo: CallDataForSeoFn = async (payload) => ({
  httpStatus: 200,
  body: {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [
          {
            keyword: payload.keyword,
            items: [
              {
                type: "organic",
                rank_group: 5,
                rank_absolute: 6,
                url: "https://www.cash-for-cars-perth.com.au/",
              },
            ],
          },
        ],
      },
    ],
  },
});

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id } });
    for (const row of rows) {
      await prisma.rankingRowAttempt.deleteMany({
        where: { rankingRowId: row.id },
      });
    }
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("GET /api/clients returns clients in the caller's workspace", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({
    data: { name: `API Test ${randomUUID()}`, workspaceId: auth.workspace.id },
  });
  try {
    const res = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c: { id: string }) => c.id === client.id));
  } finally {
    await cleanupClient(client.id);
    await auth.cleanup();
  }
});

test("GET /api/clients requires authentication", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const res = await request(app).get("/api/clients?workspaceId=whatever");
  assert.equal(res.status, 401);
});

test("full flow: upload -> start -> progress -> export, using mocked DataForSEO", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({
    data: { name: `API Test ${randomUUID()}`, workspaceId: sharedAuth.workspace.id },
  });

  try {
    const fileBuffer = await buildTestWorkbookBuffer();

    const uploadRes = await authedApp(app)
      .post("/api/runs")
      .field("clientId", client.id)
      .attach("file", fileBuffer, "test.xlsx");

    assert.equal(uploadRes.status, 201);
    assert.equal(uploadRes.body.insertedRowCount, 2);
    assert.equal(uploadRes.body.rowErrors.length, 0);
    const runId = uploadRes.body.run.id;

    const startRes = await authedApp(app).post(`/api/runs/${runId}/start`);
    assert.equal(startRes.status, 200);
    assert.equal(startRes.body.status, "PROCESSING");

    // processRun runs asynchronously in the background -- poll until terminal.
    let progress:
      | { runStatus: string; total: number; completed: number }
      | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await authedApp(app).get(`/api/runs/${runId}/progress`);
      progress = res.body;
      if (progress?.runStatus !== "PROCESSING") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(progress?.runStatus, "COMPLETED");
    assert.equal(progress?.total, 2);
    assert.equal(progress?.completed, 2);

    const exportRes = await authedApp(app).get(`/api/runs/${runId}/export`);
    assert.equal(exportRes.status, 200);
    assert.equal(
      exportRes.headers["content-type"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // supertest doesn't parse this binary content-type into res.body -- assert on the raw byte count instead.
    assert.ok(Number(exportRes.headers["content-length"]) > 0);
  } finally {
    await cleanupClient(client.id);
  }
});

test("starting a run twice is rejected (invalid transition), not silently re-run", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({
    data: { name: `API Test ${randomUUID()}`, workspaceId: sharedAuth.workspace.id },
  });

  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app)
      .post("/api/runs")
      .field("clientId", client.id)
      .attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const first = await authedApp(app).post(`/api/runs/${runId}/start`);
    assert.equal(first.status, 200);

    const second = await authedApp(app).post(`/api/runs/${runId}/start`);
    assert.equal(second.status, 409);

    // The first call's background processRun() is still in flight -- wait
    // for it to finish before cleanup, or the delete races its inserts.
    for (let i = 0; i < 50; i++) {
      const res = await authedApp(app).get(`/api/runs/${runId}/progress`);
      if (res.body.runStatus !== "PROCESSING") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/runs?clientId= lists only that client's runs, most recent first", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - runs list ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  const otherClient = await prisma.client.create({ data: { name: `API Test - runs list other ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const otherUploadRes = await authedApp(app).post("/api/runs").field("clientId", otherClient.id).attach("file", fileBuffer, "test.xlsx");

    const res = await authedApp(app).get(`/api/runs?clientId=${client.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, uploadRes.body.run.id);
    assert.ok(!res.body.some((r: { id: string }) => r.id === otherUploadRes.body.run.id));
  } finally {
    await cleanupClient(client.id);
    await cleanupClient(otherClient.id);
  }
});

test("GET /api/runs requires a clientId query parameter", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const res = await authedApp(app).get("/api/runs");
  assert.equal(res.status, 400);
});

test("DELETE /api/runs/:id removes an owned run and its rows", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - delete run ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "delete-test.xlsx");
    const runId = uploadRes.body.run.id;

    const deleteRes = await authedApp(app).delete(`/api/runs/${runId}`);
    assert.equal(deleteRes.status, 204);
    assert.equal((await prisma.rankingRun.findUnique({ where: { id: runId } })), null);
    assert.equal(await prisma.rankingRow.count({ where: { runId } }), 0);
    assert.equal((await authedApp(app).get(`/api/runs/${runId}`)).status, 404);
  } finally {
    await cleanupClient(client.id);
  }
});

test("DELETE /api/runs/:id refuses a run that is currently processing, and leaves it untouched", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - delete processing run ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "delete-processing-test.xlsx");
    const runId = uploadRes.body.run.id;

    // Force the PROCESSING state directly rather than racing the real
    // worker (the mock DataForSEO call resolves almost immediately) -- this
    // is purely exercising the delete route's own guard.
    await prisma.rankingRun.update({ where: { id: runId }, data: { status: "PROCESSING" } });

    const deleteRes = await authedApp(app).delete(`/api/runs/${runId}`);
    assert.equal(deleteRes.status, 409);

    const untouched = await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(untouched.status, "PROCESSING");
    assert.equal(await prisma.rankingRow.count({ where: { runId } }), 2, "rows must survive a rejected delete");
  } finally {
    await cleanupClient(client.id);
  }
});

test("DELETE /api/runs/:id cascades: deletes a report generated FROM this run, including its PDF artifacts on disk", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - delete cascades to report ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "delete-cascade-test.xlsx");
    const runId = uploadRes.body.run.id;
    await prisma.rankingRun.update({ where: { id: runId }, data: { status: "COMPLETED", completedAt: new Date() } });

    const clientPdfPath = path.join(os.tmpdir(), `delete-cascade-generated-${randomUUID()}.pdf`);
    const customPdfPath = path.join(os.tmpdir(), `delete-cascade-custom-${randomUUID()}.pdf`);
    await writeFile(clientPdfPath, "fake generated pdf");
    await writeFile(customPdfPath, "fake custom pdf");
    const report = await prisma.rankingReport.create({
      data: { clientId: client.id, runId, analyticsJson: { totals: { totalKeywords: 2 } }, status: "SENT", clientPdfPath, customPdfPath, sentAt: new Date() },
    });

    const deleteRes = await authedApp(app).delete(`/api/runs/${runId}`);
    assert.equal(deleteRes.status, 204);

    assert.equal(await prisma.rankingRun.findUnique({ where: { id: runId } }), null, "the run must be gone");
    assert.equal(await prisma.rankingReport.findUnique({ where: { id: report.id } }), null, "a report generated from the deleted run must be gone too, even if it was SENT");
    await assert.rejects(() => access(clientPdfPath), "the generated PDF must be removed from disk");
    await assert.rejects(() => access(customPdfPath), "the custom PDF must be removed from disk");
  } finally {
    await cleanupClient(client.id);
  }
});

test("DELETE /api/runs/:id detaches (never deletes) a report that only used this run as its historical comparison", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - delete detaches comparison run ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();

    const comparisonUpload = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "comparison-run.xlsx");
    const comparisonRunId = comparisonUpload.body.run.id;
    await prisma.rankingRun.update({ where: { id: comparisonRunId }, data: { status: "COMPLETED", completedAt: new Date() } });

    const currentUpload = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "current-run.xlsx");
    const currentRunId = currentUpload.body.run.id;
    await prisma.rankingRun.update({ where: { id: currentRunId }, data: { status: "COMPLETED", completedAt: new Date() } });

    const report = await prisma.rankingReport.create({
      data: { clientId: client.id, runId: currentRunId, previousRunId: comparisonRunId, analyticsJson: { totals: { totalKeywords: 2 } } },
    });

    const deleteRes = await authedApp(app).delete(`/api/runs/${comparisonRunId}`);
    assert.equal(deleteRes.status, 204);

    assert.equal(await prisma.rankingRun.findUnique({ where: { id: comparisonRunId } }), null, "the deleted comparison run must be gone");
    assert.ok(await prisma.rankingRun.findUnique({ where: { id: currentRunId } }), "the unrelated current run must survive untouched");
    const refetchedReport = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(refetchedReport.runId, currentRunId, "the report itself must survive -- it's not about the deleted run");
    assert.equal(refetchedReport.previousRunId, null, "only the now-gone comparison reference is cleared");
  } finally {
    await prisma.rankingReport.deleteMany({ where: { clientId: client.id } });
    await cleanupClient(client.id);
  }
});

test("GET /api/runs requires authentication -- the whole runs router is gated, not just an individual route", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const res = await request(app).get("/api/runs?clientId=whatever");
  assert.equal(res.status, 401);
});

test("GET /api/runs/:id/rows returns row-level detail in source order", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - run rows ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const res = await authedApp(app).get(`/api/runs/${runId}/rows`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].keyword, "cash for cars perth");
    assert.equal(res.body[1].keyword, "sell my car perth");
    assert.equal(res.body[0].status, "PENDING");
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/runs/:id/rows returns 404 for an unknown run", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const res = await authedApp(app).get(`/api/runs/${randomUUID()}/rows`);
  assert.equal(res.status, 404);
});

test("POST /api/runs/:id/cancel: UPLOADED -> CANCELLED, and a second cancel is rejected", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - cancel run ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const first = await authedApp(app).post(`/api/runs/${runId}/cancel`);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "CANCELLED");

    const second = await authedApp(app).post(`/api/runs/${runId}/cancel`);
    assert.equal(second.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/runs/validate: parses without persisting anything", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - validate ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const res = await authedApp(app)
      .post("/api/runs/validate")
      .field("clientId", client.id)
      .attach("file", fileBuffer, "test.xlsx");

    assert.equal(res.status, 200);
    assert.equal(res.body.insertedRowCount, 2);
    assert.equal(res.body.rowErrorCount, 0);
    assert.deepEqual(res.body.detectedColumns, Object.values(COLUMN_HEADERS));
    assert.ok(res.body.fileSizeBytes > 0);

    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    assert.equal(runs.length, 0, "validate must not create a run");
  } finally {
    await prisma.client.delete({ where: { id: client.id } });
  }
});

test("POST /api/runs/validate: missing required column returns 400 with a clear message", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - validate missing column ${randomUUID()}`, workspaceId: sharedAuth.workspace.id } });
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS).filter((h) => h !== "Ranking URL"));
    const arrayBuffer = await workbook.xlsx.writeBuffer();

    const res = await authedApp(app)
      .post("/api/runs/validate")
      .field("clientId", client.id)
      .attach("file", Buffer.from(arrayBuffer), "bad.xlsx");

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Ranking URL/);
  } finally {
    await prisma.client.delete({ where: { id: client.id } });
  }
});

test.after(async () => {
  await sharedAuth.cleanup();
  await prisma.$disconnect();
});
