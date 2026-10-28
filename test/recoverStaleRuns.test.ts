import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { recoverStaleProcessingRows } from "../backend/worker/recoverStaleRuns.js";
import { processRun } from "../backend/worker/processRun.js";
import { cancelRun } from "../backend/statemachine/runTransitions.js";
import type { DataForSeoCallResult, DataForSeoRequestPayload } from "../backend/dataforseo/client.js";

// Covers the startup recovery sweep added after a real stuck run was found
// in manual testing: a row stuck PROCESSING because the process that
// dequeued it (mid DataForSEO call) died before it could ever record an
// attempt or transition the row again -- with no automatic recovery, that
// row (and every row behind it, since processing is sequential) would sit
// stuck forever.

function okBody(rankGroup: number) {
  return { status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [{ type: "organic", rank_group: rankGroup, url: "https://example.com/" }] }] }] };
}

async function makeClient() {
  return prisma.client.create({ data: { name: `Recover Stale Test - ${randomUUID()}` } });
}

async function makeRun(clientId: string, status: "PROCESSING" | "CANCELLED" = "PROCESSING") {
  return prisma.rankingRun.create({
    data: { clientId, sourceFilename: "recover-test.xlsx", sourceFilePath: "local-test/recover-test.xlsx", totalRows: 1, status, startedAt: new Date() },
  });
}

async function makeRow(runId: string, overrides: Partial<{ status: "PROCESSING" | "PENDING"; retryCount: number }> = {}) {
  return prisma.rankingRow.create({
    data: {
      runId,
      rowUid: randomUUID(),
      sourceRowNumber: 1,
      keyword: "test keyword",
      targetUrl: "*example.*",
      locationName: "Australia",
      seDomain: "google.com.au",
      languageName: "English",
      status: overrides.status ?? "PROCESSING",
      retryCount: overrides.retryCount ?? 0,
      maxRetries: 3,
    },
  });
}

async function cleanup(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id } });
    for (const row of rows) await prisma.rankingRowAttempt.deleteMany({ where: { rankingRowId: row.id } });
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("recoverStaleProcessingRows: a row orphaned mid-first-attempt (retryCount 0) reverts to PENDING, not ERROR_RETRY, and is resumed to completion", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { status: "PROCESSING", retryCount: 0 });

    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => ({ httpStatus: 200, body: okBody(7) });
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    // processRun for the affected run is fire-and-forget -- give it a moment to actually run in this test process.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.retryCount, 0, "an interrupted attempt is never charged against the retry budget");
    assert.equal(finalRow.rankValue, 7);
  } finally {
    await cleanup(client.id);
  }
});

test("recoverStaleProcessingRows: a row orphaned after a real prior attempt (retryCount > 0) reverts to ERROR_RETRY, preserving its retry history", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { status: "PROCESSING", retryCount: 1 });

    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => ({ httpStatus: 200, body: okBody(3) });
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.retryCount, 1, "the recovery step itself must not increment retryCount -- only the resumed real attempt can");
  } finally {
    await cleanup(client.id);
  }
});

test("recoverStaleProcessingRows: a row stuck PROCESSING under a CANCELLED run is left untouched -- never silently resumed", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id, "CANCELLED");
    const row = await makeRow(run.id, { status: "PROCESSING", retryCount: 0 });

    let called = false;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      called = true;
      return { httpStatus: 200, body: okBody(1) };
    };
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(called, false, "a cancelled run's stale row must never trigger a real DataForSEO call");
    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "PROCESSING", "left exactly as found -- recovery only acts on rows under a still-PROCESSING run");
  } finally {
    await cleanup(client.id);
  }
});

test("recoverStaleProcessingRows: no-op when there is nothing stale (does not touch or re-run completed rows)", async () => {
  const client = await makeClient();
  try {
    const run = await prisma.rankingRun.create({
      data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "x", totalRows: 1, status: "COMPLETED", completedAt: new Date() },
    });
    const row = await makeRow(run.id, { status: "PROCESSING", retryCount: 0 }); // shouldn't normally coexist with a COMPLETED run, but proves the join filters correctly
    await prisma.rankingRow.update({ where: { id: row.id }, data: { status: "COMPLETED" } });

    let called = false;
    const callDataForSeo = async (): Promise<DataForSeoCallResult> => {
      called = true;
      return { httpStatus: 200, body: okBody(1) };
    };
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(called, false);
  } finally {
    await cleanup(client.id);
  }
});

// Audit 2026-10-27: a run whose process died during a retry backoff (row ERROR_RETRY) or between rows
// (rows PENDING) had NO row in PROCESSING, so the old row-based sweep never found it -- stuck forever.
test("recoverStaleProcessingRows: a PROCESSING run with only PENDING/ERROR_RETRY rows (died during backoff) is resumed and finished", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const waiting = await makeRow(run.id, { status: "PENDING" });
    const backingOff = await prisma.rankingRow.update({ where: { id: (await makeRow(run.id, { status: "PENDING", retryCount: 1 })).id }, data: { status: "ERROR_RETRY" } });

    const callDataForSeo = async (): Promise<DataForSeoCallResult> => ({ httpStatus: 200, body: okBody(5) });
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const id of [waiting.id, backingOff.id]) {
      assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id } })).status, "COMPLETED");
    }
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).status, "COMPLETED");
  } finally {
    await cleanup(client.id);
  }
});

test("recoverStaleProcessingRows: a PROCESSING run whose rows all finished (died before marking it complete) is completed without any DataForSEO call", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id);
    await prisma.rankingRow.update({ where: { id: row.id }, data: { status: "COMPLETED", rankValue: 4 } });

    let called = false;
    const callDataForSeo = async (): Promise<DataForSeoCallResult> => {
      called = true;
      return { httpStatus: 200, body: okBody(1) };
    };
    await recoverStaleProcessingRows(callDataForSeo, { onlyClientId: client.id });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(called, false, "finished rows are never re-charged");
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).status, "COMPLETED");
  } finally {
    await cleanup(client.id);
  }
});

test("processRun: cancelling a run stops it before the next DataForSEO call", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    await makeRow(run.id, { status: "PENDING" });
    await makeRow(run.id, { status: "PENDING" });
    await makeRow(run.id, { status: "PENDING" });

    let calls = 0;
    const callDataForSeo = async (): Promise<DataForSeoCallResult> => {
      calls++;
      if (calls === 1) await cancelRun(run.id); // the user clicks Cancel while the first keyword is being checked
      return { httpStatus: 200, body: okBody(2) };
    };
    await processRun(run.id, callDataForSeo, { sleep: async () => {} });

    assert.equal(calls, 1, "no further (billed) calls after the cancel");
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).status, "CANCELLED");
    assert.equal(await prisma.rankingRow.count({ where: { runId: run.id, status: "PENDING" } }), 2, "remaining rows left untouched");
  } finally {
    await cleanup(client.id);
  }
});

test("processRun: a second worker on the same run skips rows the first already claimed instead of crashing", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    await makeRow(run.id, { status: "PENDING" });
    await makeRow(run.id, { status: "PENDING" });
    const callDataForSeo = async (): Promise<DataForSeoCallResult> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { httpStatus: 200, body: okBody(6) };
    };
    await Promise.all([processRun(run.id, callDataForSeo), processRun(run.id, callDataForSeo)]);

    assert.equal(await prisma.rankingRow.count({ where: { runId: run.id, status: "COMPLETED" } }), 2);
    assert.equal(await prisma.rankingRowAttempt.count({ where: { rankingRow: { runId: run.id } } }), 2, "each keyword checked exactly once");
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).status, "COMPLETED");
  } finally {
    await cleanup(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
