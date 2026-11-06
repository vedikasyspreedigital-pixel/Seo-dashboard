import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { pruneOldRawResponses, pruneRawResponsesWhenFull } from "../backend/dataforseo/pruneRawResponses.js";

// The user's choice (2026-10-28): DataForSEO's raw answers are kept 40 days. Only the raw answer goes --
// the attempt record and the row's rank stay.

test("pruneOldRawResponses: empties raw answers older than 40 days; ranks, attempt records and newer answers stay", async () => {
  const client = await prisma.client.create({ data: { name: `Prune Raw Test ${randomUUID()}` } });
  try {
    const run = await prisma.rankingRun.create({ data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "x", totalRows: 1, status: "COMPLETED" } });
    const row = await prisma.rankingRow.create({
      data: { runId: run.id, rowUid: randomUUID(), sourceRowNumber: 2, keyword: "yoga", targetUrl: "*a.*", locationName: "Australia", seDomain: "google.com.au", languageName: "English", status: "COMPLETED", rankValue: 7, rankDisplay: "7" },
    });
    const attempt = (daysAgo: number) =>
      prisma.rankingRowAttempt.create({
        data: {
          rankingRowId: row.id,
          attemptNumber: daysAgo,
          requestPayload: { keyword: "yoga" },
          rawResponse: { tasks: [{ result: [{ items: ["a big Google page"] }] }] },
          mappedRankValue: 7,
          outcome: "SUCCESS",
          createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        },
      });
    const old = await attempt(41);
    const recent = await attempt(39);

    assert.ok((await pruneOldRawResponses()) >= 1);
    const oldAfter = await prisma.rankingRowAttempt.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(oldAfter.rawResponse, null, "older than 40 days: raw answer emptied");
    assert.equal(oldAfter.mappedRankValue, 7, "the attempt's own record stays");
    assert.equal(oldAfter.outcome, "SUCCESS");
    assert.notEqual((await prisma.rankingRowAttempt.findUniqueOrThrow({ where: { id: recent.id } })).rawResponse, null, "39 days: kept");
    assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } })).rankValue, 7, "the rank stays");
  } finally {
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    for (const r of runs) {
      await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: r.id } } });
      await prisma.rankingRow.deleteMany({ where: { runId: r.id } });
    }
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  }
});

test("database full: raw answers older than 7 days are emptied (ranks stay); under the limit nothing changes", async () => {
  const client = await prisma.client.create({ data: { name: `Prune Full Test ${randomUUID()}` } });
  try {
    const run = await prisma.rankingRun.create({ data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "x", totalRows: 1, status: "COMPLETED" } });
    const row = await prisma.rankingRow.create({
      data: { runId: run.id, rowUid: randomUUID(), sourceRowNumber: 2, keyword: "yoga", targetUrl: "*a.*", locationName: "Australia", seDomain: "google.com.au", languageName: "English", status: "COMPLETED", rankValue: 7, rankDisplay: "7" },
    });
    const attempt = (daysAgo: number) =>
      prisma.rankingRowAttempt.create({
        data: {
          rankingRowId: row.id,
          attemptNumber: daysAgo,
          requestPayload: { keyword: "yoga" },
          rawResponse: { tasks: [{ result: [{ items: ["a big Google page"] }] }] },
          mappedRankValue: 7,
          outcome: "SUCCESS",
          createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        },
      });
    const tenDays = await attempt(10);
    const twoDays = await attempt(2);
    const raw = async (id: string) => (await prisma.rankingRowAttempt.findUniqueOrThrow({ where: { id } })).rawResponse;
    const GB = 1024 ** 3;

    const under = await pruneRawResponsesWhenFull({ env: { RAW_RESPONSE_DB_LIMIT_GB: "3" }, databaseBytes: async () => 2.5 * GB });
    assert.equal(under.full, false);
    assert.notEqual(await raw(tenDays.id), null, "under the limit: the normal 40 days apply");

    const over = await pruneRawResponsesWhenFull({ env: { RAW_RESPONSE_DB_LIMIT_GB: "3" }, databaseBytes: async () => 3.4 * GB });
    assert.equal(over.full, true);
    assert.equal(over.sizeGb, 3.4);
    assert.ok(over.emptied >= 1);
    assert.equal(await raw(tenDays.id), null, "over the limit: older than 7 days is emptied");
    assert.notEqual(await raw(twoDays.id), null, "the last 7 days stay (debug details still work)");
    assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } })).rankValue, 7, "the rank stays");

    await pruneRawResponsesWhenFull({ env: { RAW_RESPONSE_DB_LIMIT_GB: "3", RAW_RESPONSE_KEEP_DAYS_WHEN_FULL: "1" }, databaseBytes: async () => 3.4 * GB });
    assert.equal(await raw(twoDays.id), null, "RAW_RESPONSE_KEEP_DAYS_WHEN_FULL changes the days");
  } finally {
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    for (const r of runs) {
      await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: r.id } } });
      await prisma.rankingRow.deleteMany({ where: { runId: r.id } });
    }
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  }
});

test("database size is read from Postgres when no size is given", async () => {
  const result = await pruneRawResponsesWhenFull({ env: { RAW_RESPONSE_DB_LIMIT_GB: "1000" } });
  assert.equal(result.full, false);
  assert.ok(result.sizeGb >= 0);
});

test.after(async () => {
  await prisma.$disconnect();
});
