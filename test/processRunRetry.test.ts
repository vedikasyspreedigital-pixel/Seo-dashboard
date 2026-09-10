import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { processRun } from "../backend/worker/processRun.js";
import type { DataForSeoCallResult, DataForSeoRequestPayload } from "../backend/dataforseo/client.js";

// Regression tests for the retry-loop fix: a row that comes back
// ERROR_RETRY must be retried again IN PLACE within the same processRun()
// call (no new run, no manual re-trigger), until it either succeeds or
// exhausts retryCount/maxRetries -- exactly the gap found via real
// production data (9 rows landing in FAILED after a single attempt each,
// because retryable errors were misclassified as permanent).

function okBody(taskStatusCode: number, taskStatusMessage: string) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: taskStatusCode, status_message: taskStatusMessage, result: null }],
  };
}

async function makeClient() {
  return prisma.client.create({ data: { name: `Retry Test - ${randomUUID()}` } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "retry-test.xlsx",
      sourceFilePath: "local-test/retry-test.xlsx",
      totalRows: 1,
      status: "PROCESSING",
      startedAt: new Date(),
    },
  });
}

async function makeRow(runId: string, overrides: Partial<{ maxRetries: number }> = {}) {
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
      status: "PENDING",
      maxRetries: overrides.maxRetries ?? 3,
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

test("a row that fails once with a retryable code (40101) is retried in place and succeeds -- no new run needed", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 3 });

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      if (callCount === 1) return { httpStatus: 200, body: okBody(40101, "Internal SE Server Error.") };
      return { httpStatus: 200, body: { status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [{ type: "organic", rank_group: 5, url: "https://example.com/" }] }] }] } };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 2, "should have called DataForSEO twice: fail once, succeed on retry");

    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.retryCount, 1);
    assert.equal(finalRow.rankValue, 5);

    const attempts = await prisma.rankingRowAttempt.findMany({ where: { rankingRowId: row.id }, orderBy: { attemptNumber: "asc" } });
    assert.equal(attempts.length, 2, "both attempts must be preserved in RankingRowAttempt history");
    assert.equal(attempts[0].outcome, "API_ERROR");
    assert.equal(attempts[0].dataforseoStatusCode, 40101);
    assert.equal(attempts[1].outcome, "SUCCESS");

    const finalRun = await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finalRun.status, "COMPLETED", "run only reaches terminal status once the retried row is done");
  } finally {
    await cleanup(client.id);
  }
});

test("a row that never succeeds exhausts retries and becomes FAILED after exactly maxRetries total attempts", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 2 });

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      return { httpStatus: 200, body: okBody(40106, "Task completed with partial results.") };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 2, "maxRetries=2 must mean 2 TOTAL attempts, not 2 retries on top of an initial one");

    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "FAILED");
    assert.equal(finalRow.retryCount, 2);

    const attempts = await prisma.rankingRowAttempt.findMany({ where: { rankingRowId: row.id }, orderBy: { attemptNumber: "asc" } });
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((a) => a.dataforseoStatusCode === 40106));

    const finalRun = await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finalRun.status, "COMPLETED_WITH_ERRORS");
  } finally {
    await cleanup(client.id);
  }
});

test("a permanent (non-retryable) error still fails immediately after just 1 attempt, unchanged", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 3 });

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      return { httpStatus: 200, body: okBody(40100, "Auth error. Invalid Login/Password.") };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 1, "a genuinely permanent error must not be retried at all");
    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "FAILED");
    assert.equal(finalRow.retryCount, 1);
  } finally {
    await cleanup(client.id);
  }
});

test("40102 (No Search Results) still completes immediately as Not-in-100, no retry triggered", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id);

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      return { httpStatus: 200, body: okBody(40102, "No Search Results.") };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 1);
    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.rankValue, null);
    assert.equal(finalRow.rankDisplay, "Not in 100");
  } finally {
    await cleanup(client.id);
  }
});
