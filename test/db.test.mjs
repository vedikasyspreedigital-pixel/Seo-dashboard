import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../backend/db/client.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { buildSampleWorkbook } from "./helpers/sampleWorkbook.mjs";

// These tests hit the real local Postgres container (DATABASE_URL in .env,
// expected to be localhost:5433 / serp-ranking-db). Each test creates its
// own Client so runs don't collide, and cleans up everything it inserted.

async function makeTestClient(name) {
  return prisma.client.create({ data: { name } });
}

async function cleanupClient(clientId) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

// Audit 2026-10-27 (#15b): rows were inserted one by one inside a 5-second transaction, so a big keyword
// file timed out. A 3,000-keyword file must go in, every row intact and in order.
test("ingestExcelRun: a 3,000-keyword file is created in full", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { COLUMN_HEADERS } = await import("../backend/excel/parser.js");
  const client = await makeTestClient("DB Test - big file");
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS));
    for (let i = 0; i < 3000; i++) sheet.addRow([`keyword number ${i}`, "https://example.com/", "*example.*", `keyword number ${i} example`, "Australia", "google.com.au", "English", "Pending", "", ""]);
    const started = Date.now();
    const { run, insertedRowCount } = await ingestExcelRun({
      clientId: client.id,
      sourceFilename: "big.xlsx",
      sourceFilePath: "local-test/big.xlsx",
      fileBuffer: await workbook.xlsx.writeBuffer(),
    });
    assert.equal(insertedRowCount, 3000);
    assert.equal(await prisma.rankingRow.count({ where: { runId: run.id } }), 3000);
    const last = await prisma.rankingRow.findFirst({ where: { runId: run.id }, orderBy: { sourceRowNumber: "desc" } });
    assert.equal(last.keyword, "keyword number 2999");
    assert.equal(last.sourceRowNumber, 3001);
    console.log(`3,000 rows ingested in ${Date.now() - started} ms`);
  } finally {
    await cleanupClient(client.id);
  }
});

test("ingestExcelRun creates a ranking_run and matching ranking_rows in Postgres", async () => {
  const client = await makeTestClient("DB Test - Cash For Cars Perth");
  try {
    const buffer = await (await buildSampleWorkbook()).xlsx.writeBuffer();

    const { run, insertedRowCount, rowErrors, totalDataRows } =
      await ingestExcelRun({
        clientId: client.id,
        sourceFilename: "cash-for-cars-perth.xlsx",
        sourceFilePath: "local-test/cash-for-cars-perth.xlsx",
        fileBuffer: buffer,
      });

    assert.equal(totalDataRows, 4); // 3 valid + 1 with a missing required field
    assert.equal(insertedRowCount, 3);
    assert.equal(rowErrors.length, 1);
    assert.equal(run.clientId, client.id);
    assert.equal(run.totalRows, 3);
    assert.equal(run.status, "UPLOADED");

    const persistedRun = await prisma.rankingRun.findUnique({
      where: { id: run.id },
      include: { rows: true, client: true },
    });

    assert.equal(persistedRun.rows.length, 3); // FK: rows really belong to this run
    assert.equal(persistedRun.client.id, client.id); // FK: run really belongs to this client

    const byKeyword = Object.fromEntries(
      persistedRun.rows.map((r) => [r.keyword, r]),
    );

    const completed = byKeyword["cash for cars perth"];
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.targetUrl, "*cash-for-cars-perth.*"); // stored verbatim
    assert.equal(completed.rankValue, 8);
    assert.equal(completed.rankDisplay, "8");
    assert.equal(
      completed.rankingUrl,
      "https://www.cash-for-cars-perth.com.au/",
    );

    const pending = byKeyword["sell my car perth"];
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.rankValue, null);

    const retry = byKeyword["car removal perth"];
    assert.equal(retry.status, "ERROR_RETRY");

    // Every row_uid actually persisted and is unique within this run.
    const rowUids = new Set(persistedRun.rows.map((r) => r.rowUid));
    assert.equal(rowUids.size, 3);
  } finally {
    await cleanupClient(client.id);
  }
});

test("foreign key restricts deleting a client that still has a ranking_run", async () => {
  const client = await makeTestClient("DB Test - FK Restrict Check");
  try {
    const buffer = await (await buildSampleWorkbook()).xlsx.writeBuffer();
    const { run } = await ingestExcelRun({
      clientId: client.id,
      sourceFilename: "cash-for-cars-perth.xlsx",
      sourceFilePath: "local-test/cash-for-cars-perth.xlsx",
      fileBuffer: buffer,
    });
    assert.ok(run.id);

    await assert.rejects(
      () => prisma.client.delete({ where: { id: client.id } }),
      /Foreign key constraint/,
    );
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
