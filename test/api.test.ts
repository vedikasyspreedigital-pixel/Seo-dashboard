import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Full HTTP-layer test against the real local Postgres container
// (localhost:5433). DataForSEO is mocked -- no real API calls here.

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

test("GET /api/clients returns clients", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({
    data: { name: `API Test ${randomUUID()}` },
  });
  try {
    const res = await request(app).get("/api/clients");
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c: { id: string }) => c.id === client.id));
  } finally {
    await cleanupClient(client.id);
  }
});

test("full flow: upload -> start -> progress -> export, using mocked DataForSEO", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({
    data: { name: `API Test ${randomUUID()}` },
  });

  try {
    const fileBuffer = await buildTestWorkbookBuffer();

    const uploadRes = await request(app)
      .post("/api/runs")
      .field("clientId", client.id)
      .attach("file", fileBuffer, "test.xlsx");

    assert.equal(uploadRes.status, 201);
    assert.equal(uploadRes.body.insertedRowCount, 2);
    assert.equal(uploadRes.body.rowErrors.length, 0);
    const runId = uploadRes.body.run.id;

    const startRes = await request(app).post(`/api/runs/${runId}/start`);
    assert.equal(startRes.status, 200);
    assert.equal(startRes.body.status, "PROCESSING");

    // processRun runs asynchronously in the background -- poll until terminal.
    let progress:
      | { runStatus: string; total: number; completed: number }
      | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await request(app).get(`/api/runs/${runId}/progress`);
      progress = res.body;
      if (progress?.runStatus !== "PROCESSING") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(progress?.runStatus, "COMPLETED");
    assert.equal(progress?.total, 2);
    assert.equal(progress?.completed, 2);

    const exportRes = await request(app).get(`/api/runs/${runId}/export`);
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
    data: { name: `API Test ${randomUUID()}` },
  });

  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await request(app)
      .post("/api/runs")
      .field("clientId", client.id)
      .attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const first = await request(app).post(`/api/runs/${runId}/start`);
    assert.equal(first.status, 200);

    const second = await request(app).post(`/api/runs/${runId}/start`);
    assert.equal(second.status, 409);

    // The first call's background processRun() is still in flight -- wait
    // for it to finish before cleanup, or the delete races its inserts.
    for (let i = 0; i < 50; i++) {
      const res = await request(app).get(`/api/runs/${runId}/progress`);
      if (res.body.runStatus !== "PROCESSING") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/runs?clientId= lists only that client's runs, most recent first", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - runs list ${randomUUID()}` } });
  const otherClient = await prisma.client.create({ data: { name: `API Test - runs list other ${randomUUID()}` } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await request(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const otherUploadRes = await request(app).post("/api/runs").field("clientId", otherClient.id).attach("file", fileBuffer, "test.xlsx");

    const res = await request(app).get(`/api/runs?clientId=${client.id}`);
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
  const res = await request(app).get("/api/runs");
  assert.equal(res.status, 400);
});

test("GET /api/runs/:id/rows returns row-level detail in source order", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - run rows ${randomUUID()}` } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await request(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const res = await request(app).get(`/api/runs/${runId}/rows`);
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
  const res = await request(app).get(`/api/runs/${randomUUID()}/rows`);
  assert.equal(res.status, 404);
});

test("POST /api/runs/:id/cancel: UPLOADED -> CANCELLED, and a second cancel is rejected", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - cancel run ${randomUUID()}` } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const uploadRes = await request(app).post("/api/runs").field("clientId", client.id).attach("file", fileBuffer, "test.xlsx");
    const runId = uploadRes.body.run.id;

    const first = await request(app).post(`/api/runs/${runId}/cancel`);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "CANCELLED");

    const second = await request(app).post(`/api/runs/${runId}/cancel`);
    assert.equal(second.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/runs/validate: parses without persisting anything", async () => {
  const app = createApp(mockCallDataForSeo, 'mock');
  const client = await prisma.client.create({ data: { name: `API Test - validate ${randomUUID()}` } });
  try {
    const fileBuffer = await buildTestWorkbookBuffer();
    const res = await request(app)
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
  const client = await prisma.client.create({ data: { name: `API Test - validate missing column ${randomUUID()}` } });
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS).filter((h) => h !== "Ranking URL"));
    const arrayBuffer = await workbook.xlsx.writeBuffer();

    const res = await request(app)
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
  await prisma.$disconnect();
});
