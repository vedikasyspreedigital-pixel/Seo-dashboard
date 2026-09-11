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

test("40102 (No Search Results) with a full-depth crawl still completes immediately as Not-in-100, no retry triggered", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id);

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      return {
        httpStatus: 200,
        body: {
          status_code: 20000,
          status_message: "Ok.",
          tasks: [
            {
              status_code: 40102,
              status_message: "No Search Results.",
              result: [{ items: null, pages_count: 10 }],
            },
          ],
        },
      };
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

// Regression test for the false "Not in 100" bug, reproduced end-to-end
// through processRun's real retry loop. Modeled on the real "car steerio abu
// dhabi" / emiratessound.com row: a shallow first crawl (pages_count 1) came
// back 40102 and was wrongly written as "Not in 100"; a full-depth crawl the
// next day found rank 12. With the fix, the shallow crawl must be retried
// in place instead of being trusted.
test("40102 with a shallow crawl (pages_count short of depth) is retried, then succeeds once a full-depth crawl finds the target", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 3 });

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      if (callCount === 1) {
        return {
          httpStatus: 200,
          body: {
            status_code: 20000,
            status_message: "Ok.",
            tasks: [
              { status_code: 40102, status_message: "No Search Results.", result: [{ items: null, pages_count: 1 }] },
            ],
          },
        };
      }
      return {
        httpStatus: 200,
        body: {
          status_code: 20000,
          status_message: "Ok.",
          tasks: [
            {
              status_code: 20000,
              status_message: "Ok.",
              result: [{ items: [{ type: "organic", rank_group: 12, rank_absolute: 17, url: "https://emiratessound.com/" }] }],
            },
          ],
        },
      };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 2, "shallow 40102 crawl must be retried, not trusted as Not-in-100");
    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.rankValue, 12);
    assert.equal(finalRow.rankDisplay, "12");

    const attempts = await prisma.rankingRowAttempt.findMany({ where: { rankingRowId: row.id }, orderBy: { attemptNumber: "asc" } });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].outcome, "API_ERROR", "shallow crawl must be recorded as retryable, not a SUCCESS Not-in-100");
    assert.equal(attempts[1].outcome, "SUCCESS");
  } finally {
    await cleanup(client.id);
  }
});

// Regression test for the discarded-valid-match bug, reproduced end-to-end.
// Modeled on the real "autopsy headrest australia" / pangalark.com.au row:
// task status 40106 came back with a confident rank_group=1 match in items,
// but the old mapper discarded it and retried until FAILED. With the fix,
// the match is accepted on the very first attempt -- no retry needed.
test("40106 with a matching item is accepted immediately -- no retry needed, rank written on the first attempt", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 3 });

    let callCount = 0;
    const callDataForSeo = async (_payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> => {
      callCount++;
      return {
        httpStatus: 200,
        body: {
          status_code: 20000,
          status_message: "Ok.",
          tasks: [
            {
              status_code: 40106,
              status_message: "Task completed with partial results.",
              result: [
                {
                  items: [
                    {
                      type: "organic",
                      rank_group: 1,
                      rank_absolute: 2,
                      url: "https://www.pangalark.com.au/product/headrest-rubber-ba025/",
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    };

    await processRun(run.id, callDataForSeo);

    assert.equal(callCount, 1, "a confident match in a partial-results response must be accepted, not retried");
    const finalRow = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, "COMPLETED");
    assert.equal(finalRow.rankValue, 1);
    assert.equal(finalRow.rankingUrl, "https://www.pangalark.com.au/product/headrest-rubber-ba025/");
  } finally {
    await cleanup(client.id);
  }
});
