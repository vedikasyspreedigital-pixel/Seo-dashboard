import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../backend/db/client.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { buildSampleWorkbook } from "../scripts/create-sample-excel.mjs";

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
