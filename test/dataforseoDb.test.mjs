import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";
import { recordAttemptAndApply } from "../backend/dataforseo/recordAttemptAndApply.js";
import { dequeueRow } from "../backend/statemachine/rowTransitions.js";

// Local only: real Postgres (localhost:5433), mocked DataForSEO responses.
// No live API calls anywhere in this file.

async function makeClient(name) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "dataforseo-test.xlsx",
      sourceFilePath: "local-test/dataforseo-test.xlsx",
      totalRows: 1,
      status: "PROCESSING",
    },
  });
}

async function makePendingRow(runId, overrides = {}) {
  return prisma.rankingRow.create({
    data: {
      runId,
      rowUid: randomUUID(),
      sourceRowNumber: 2,
      keyword: "cash for cars perth",
      targetUrl: "*cash-for-cars-perth.*",
      locationName: "Australia",
      seDomain: "google.com.au",
      languageName: "English",
      status: "PENDING",
      maxRetries: 3,
      retryCount: 0,
      ...overrides,
    },
  });
}

async function cleanupClient(clientId) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.updateMany({
      where: { runId: run.id },
      data: { lastAttemptId: null },
    });
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

function successBody(rankGroup, url) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [
          {
            keyword: "cash for cars perth",
            items: [
              {
                type: "organic",
                rank_group: rankGroup,
                rank_absolute: rankGroup + 1,
                domain: "cash-for-cars-perth.com.au",
                title: "Cash For Cars Perth",
                url,
                breadcrumb: "cash-for-cars-perth.com.au",
              },
            ],
          },
        ],
      },
    ],
  };
}

test("successful response: row completes, attempt persisted with raw response", async () => {
  const client = await makeClient("DataForSEO Test - success");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id);
    await dequeueRow(row.id);

    const requestPayload = buildDataForSeoRequest(row);
    const responseBody = successBody(
      8,
      "https://www.cash-for-cars-perth.com.au/",
    );

    const {
      row: updatedRow,
      attempt,
      mapped,
    } = await recordAttemptAndApply(row.id, {
      requestPayload,
      httpStatus: 200,
      responseBody,
    });

    assert.equal(mapped.outcome, "SUCCESS");
    assert.equal(updatedRow.status, "COMPLETED");
    assert.equal(updatedRow.rankValue, 8);
    assert.equal(updatedRow.rankDisplay, "8");
    assert.equal(
      updatedRow.rankingUrl,
      "https://www.cash-for-cars-perth.com.au/",
    );

    assert.equal(attempt.outcome, "SUCCESS");
    assert.deepEqual(attempt.requestPayload, requestPayload);
    assert.deepEqual(attempt.rawResponse, responseBody); // raw response persisted verbatim
    assert.equal(attempt.attemptNumber, 1);

    const persistedRow = await prisma.rankingRow.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(persistedRow.lastAttemptId, attempt.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test('not-found response: row completes as "Not in 100"', async () => {
  const client = await makeClient("DataForSEO Test - not found");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id, { keyword: "unrelated keyword" });
    await dequeueRow(row.id);

    const emptyBody = {
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          status_code: 20000,
          status_message: "Ok.",
          result: [{ keyword: "unrelated keyword", items: [] }],
        },
      ],
    };

    const { row: updatedRow, mapped } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: emptyBody,
    });

    assert.equal(mapped.outcome, "SUCCESS");
    assert.equal(updatedRow.status, "COMPLETED");
    assert.equal(updatedRow.rankValue, null);
    assert.equal(updatedRow.rankDisplay, "Not in 100");
    assert.equal(updatedRow.rankingUrl, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("retryable API error: row goes to ERROR_RETRY, retry_count increments, raw response still saved", async () => {
  const client = await makeClient("DataForSEO Test - retryable error");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id);
    await dequeueRow(row.id);

    const errorBody = {
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 50000, status_message: "Internal Error." }],
    };

    const {
      row: updatedRow,
      attempt,
      mapped,
    } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: errorBody,
    });

    assert.equal(mapped.retryable, true);
    assert.equal(updatedRow.status, "ERROR_RETRY");
    assert.equal(updatedRow.retryCount, 1);
    assert.equal(updatedRow.lastErrorMessage, "Internal Error.");
    assert.equal(attempt.outcome, "API_ERROR");
    assert.deepEqual(attempt.rawResponse, errorBody); // credit already spent -- response is not lost
  } finally {
    await cleanupClient(client.id);
  }
});

test("non-retryable API error: row goes straight to FAILED even with retries remaining", async () => {
  const client = await makeClient("DataForSEO Test - non-retryable error");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id, { maxRetries: 3, retryCount: 0 });
    await dequeueRow(row.id);

    const errorBody = {
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 40501, status_message: "Invalid Field Format." }],
    };

    const { row: updatedRow, mapped } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: errorBody,
    });

    assert.equal(mapped.retryable, false);
    assert.equal(updatedRow.status, "FAILED"); // not ERROR_RETRY, despite retryCount(1) < maxRetries(3)
    assert.equal(updatedRow.retryCount, 1);
  } finally {
    await cleanupClient(client.id);
  }
});

test("transport failure (no response at all): treated as retryable, raw_response is null", async () => {
  const client = await makeClient("DataForSEO Test - transport failure");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id);
    await dequeueRow(row.id);

    const {
      row: updatedRow,
      attempt,
      mapped,
    } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      transportError: new Error("ECONNRESET"),
    });

    assert.equal(mapped.retryable, true);
    assert.equal(updatedRow.status, "ERROR_RETRY");
    assert.equal(attempt.rawResponse, null);
    assert.equal(attempt.errorMessage, "ECONNRESET");
  } finally {
    await cleanupClient(client.id);
  }
});

test("malformed response: row goes to ERROR_RETRY, attempt recorded as MAPPING_ERROR (distinct from API_ERROR)", async () => {
  const client = await makeClient("DataForSEO Test - malformed response");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id);
    await dequeueRow(row.id);

    const garbledBody = { status_code: 20000, status_message: "Ok." }; // no tasks[]

    const {
      row: updatedRow,
      attempt,
      mapped,
    } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: garbledBody,
    });

    assert.equal(mapped.outcome, "MAPPING_ERROR");
    assert.equal(attempt.outcome, "MAPPING_ERROR");
    assert.equal(updatedRow.status, "ERROR_RETRY");
  } finally {
    await cleanupClient(client.id);
  }
});

test("a second attempt on the same row is recorded as attempt_number 2", async () => {
  const client = await makeClient("DataForSEO Test - second attempt numbering");
  try {
    const run = await makeRun(client.id);
    const row = await makePendingRow(run.id);
    await dequeueRow(row.id);

    await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: {
        status_code: 20000,
        status_message: "Ok.",
        tasks: [{ status_code: 50000, status_message: "Internal Error." }],
      },
    });

    await dequeueRow(row.id); // ERROR_RETRY -> PROCESSING for the retry

    const { attempt } = await recordAttemptAndApply(row.id, {
      requestPayload: buildDataForSeoRequest(row),
      httpStatus: 200,
      responseBody: successBody(8, "https://www.cash-for-cars-perth.com.au/"),
    });

    assert.equal(attempt.attemptNumber, 2);

    const allAttempts = await prisma.rankingRowAttempt.findMany({
      where: { rankingRowId: row.id },
    });
    assert.equal(allAttempts.length, 2);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
