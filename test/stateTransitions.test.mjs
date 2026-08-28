import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import {
  isValidRowTransition,
  dequeueRow,
  completeRow,
  failRowAttempt,
} from "../backend/statemachine/rowTransitions.js";
import {
  isValidRunTransition,
  startRun,
  cancelRun,
  recomputeRunCompletion,
} from "../backend/statemachine/runTransitions.js";
import {
  InvalidRowTransitionError,
  InvalidRunTransitionError,
} from "../backend/statemachine/errors.js";

// All local: exercises the real serp-ranking-db Postgres container
// (localhost:5433). No DataForSEO calls, no external services.

async function makeClient(name) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId, overrides = {}) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "state-test.xlsx",
      sourceFilePath: "local-test/state-test.xlsx",
      totalRows: 1,
      status: "UPLOADED",
      ...overrides,
    },
  });
}

async function makeRow(runId, overrides = {}) {
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
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

// --- pure graph checks, no DB ---

test("row transition graph matches the locked state machine", () => {
  assert.equal(isValidRowTransition("PENDING", "PROCESSING"), true);
  assert.equal(isValidRowTransition("PROCESSING", "COMPLETED"), true);
  assert.equal(isValidRowTransition("PROCESSING", "ERROR_RETRY"), true);
  assert.equal(isValidRowTransition("PROCESSING", "FAILED"), true);
  assert.equal(isValidRowTransition("ERROR_RETRY", "PROCESSING"), true);

  assert.equal(isValidRowTransition("COMPLETED", "PROCESSING"), false);
  assert.equal(isValidRowTransition("FAILED", "PROCESSING"), false);
  assert.equal(isValidRowTransition("PENDING", "COMPLETED"), false);
  assert.equal(isValidRowTransition("ERROR_RETRY", "FAILED"), false);
});

test("run transition graph matches the locked state machine", () => {
  assert.equal(isValidRunTransition("UPLOADED", "PROCESSING"), true);
  assert.equal(isValidRunTransition("PROCESSING", "COMPLETED"), true);
  assert.equal(
    isValidRunTransition("PROCESSING", "COMPLETED_WITH_ERRORS"),
    true,
  );
  assert.equal(isValidRunTransition("COMPLETED", "PROCESSING"), false);
  assert.equal(
    isValidRunTransition("COMPLETED_WITH_ERRORS", "PROCESSING"),
    false,
  );
});

// --- row lifecycle, against real rows in the local container ---

test("PENDING -> PROCESSING -> COMPLETED", async () => {
  const client = await makeClient("State Test - happy path");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id);

    const processing = await dequeueRow(row.id);
    assert.equal(processing.status, "PROCESSING");

    const completed = await completeRow(row.id, {
      rankValue: 8,
      rankDisplay: "8",
      rankingUrl: "https://www.cash-for-cars-perth.com.au/",
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.rankValue, 8);
    assert.equal(
      completed.rankingUrl,
      "https://www.cash-for-cars-perth.com.au/",
    );
  } finally {
    await cleanupClient(client.id);
  }
});

test("PENDING -> PROCESSING -> ERROR_RETRY (retries remain)", async () => {
  const client = await makeClient("State Test - error retry");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { maxRetries: 3, retryCount: 0 });

    await dequeueRow(row.id);
    const failed = await failRowAttempt(row.id, {
      errorMessage: "DataForSEO timeout",
    });

    assert.equal(failed.status, "ERROR_RETRY");
    assert.equal(failed.retryCount, 1);
    assert.equal(failed.lastErrorMessage, "DataForSEO timeout");
  } finally {
    await cleanupClient(client.id);
  }
});

test("ERROR_RETRY -> PROCESSING -> COMPLETED", async () => {
  const client = await makeClient("State Test - retry then succeed");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, {
      status: "ERROR_RETRY",
      retryCount: 1,
      maxRetries: 3,
    });

    const processing = await dequeueRow(row.id);
    assert.equal(processing.status, "PROCESSING");

    const completed = await completeRow(row.id, {
      rankValue: 14,
      rankDisplay: "14",
      rankingUrl: "https://example.com/",
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.retryCount, 1); // completing doesn't reset/touch retry history
  } finally {
    await cleanupClient(client.id);
  }
});

test("exhausting retries moves PROCESSING -> FAILED, not ERROR_RETRY", async () => {
  const client = await makeClient("State Test - exhausted retries");
  try {
    const run = await makeRun(client.id);
    // Row is already mid-attempt (as it would be right after a real dequeueRow).
    const row = await makeRow(run.id, {
      status: "PROCESSING",
      retryCount: 2,
      maxRetries: 3,
    });

    const result = await failRowAttempt(row.id, {
      errorMessage: "DataForSEO 500",
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.retryCount, 3);
  } finally {
    await cleanupClient(client.id);
  }
});

test("invalid transitions are rejected, not silently applied", async () => {
  const client = await makeClient("State Test - invalid transitions");
  try {
    const run = await makeRun(client.id);

    const completedRow = await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 8,
      rankDisplay: "8",
    });
    await assert.rejects(
      () => dequeueRow(completedRow.id),
      InvalidRowTransitionError,
    );
    await assert.rejects(
      () => completeRow(completedRow.id, { rankValue: 1, rankDisplay: "1" }),
      InvalidRowTransitionError,
    );

    const failedRow = await makeRow(run.id, {
      status: "FAILED",
      retryCount: 3,
      maxRetries: 3,
    });
    await assert.rejects(
      () => dequeueRow(failedRow.id),
      InvalidRowTransitionError,
    );

    const pendingRow = await makeRow(run.id, { status: "PENDING" });
    // Can't jump straight to COMPLETED/ERROR_RETRY without going through PROCESSING first.
    await assert.rejects(
      () => completeRow(pendingRow.id, { rankValue: 1, rankDisplay: "1" }),
      InvalidRowTransitionError,
    );
    await assert.rejects(
      () => failRowAttempt(pendingRow.id, { errorMessage: "x" }),
      InvalidRowTransitionError,
    );
  } finally {
    await cleanupClient(client.id);
  }
});

test("completed rows cannot accidentally be changed back, and are left untouched by the rejected attempt", async () => {
  const client = await makeClient("State Test - completed is terminal");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 8,
      rankDisplay: "8",
      rankingUrl: "https://www.cash-for-cars-perth.com.au/",
    });

    await assert.rejects(() => dequeueRow(row.id), InvalidRowTransitionError);
    await assert.rejects(
      () =>
        completeRow(row.id, {
          rankValue: 99,
          rankDisplay: "99",
          rankingUrl: "https://someone-else.example/",
        }),
      InvalidRowTransitionError,
    );
    await assert.rejects(
      () => failRowAttempt(row.id, { errorMessage: "should not apply" }),
      InvalidRowTransitionError,
    );

    const unchanged = await prisma.rankingRow.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(unchanged.status, "COMPLETED");
    assert.equal(unchanged.rankValue, 8);
    assert.equal(
      unchanged.rankingUrl,
      "https://www.cash-for-cars-perth.com.au/",
    );
    assert.equal(unchanged.retryCount, 0);
  } finally {
    await cleanupClient(client.id);
  }
});

test("status changes preserve the row/run/client relationships", async () => {
  const client = await makeClient("State Test - relationships preserved");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id);

    await dequeueRow(row.id);
    await completeRow(row.id, {
      rankValue: 8,
      rankDisplay: "8",
      rankingUrl: "https://www.cash-for-cars-perth.com.au/",
    });

    const persisted = await prisma.rankingRow.findUniqueOrThrow({
      where: { id: row.id },
      include: { run: { include: { client: true } } },
    });
    assert.equal(persisted.runId, run.id);
    assert.equal(persisted.run.id, run.id);
    assert.equal(persisted.run.client.id, client.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("concurrent dequeue on the same row: exactly one winner, no corruption", async () => {
  const client = await makeClient("State Test - concurrent dequeue");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, { status: "PENDING" });

    const results = await Promise.allSettled([
      dequeueRow(row.id),
      dequeueRow(row.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof InvalidRowTransitionError);

    const final = await prisma.rankingRow.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(final.status, "PROCESSING");
  } finally {
    await cleanupClient(client.id);
  }
});

test("concurrent failRowAttempt on the same row: retry_count increments exactly once", async () => {
  const client = await makeClient("State Test - concurrent fail attempt");
  try {
    const run = await makeRun(client.id);
    const row = await makeRow(run.id, {
      status: "PROCESSING",
      retryCount: 0,
      maxRetries: 3,
    });

    const results = await Promise.allSettled([
      failRowAttempt(row.id, { errorMessage: "attempt A" }),
      failRowAttempt(row.id, { errorMessage: "attempt B" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const final = await prisma.rankingRow.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(final.retryCount, 1); // not 2 -- no double-decrement of the retry budget
    assert.equal(final.status, "ERROR_RETRY");
  } finally {
    await cleanupClient(client.id);
  }
});

// --- run lifecycle ---

test("startRun: UPLOADED -> PROCESSING, and is not re-runnable", async () => {
  const client = await makeClient("State Test - start run");
  try {
    const run = await makeRun(client.id);
    const started = await startRun(run.id);
    assert.equal(started.status, "PROCESSING");
    assert.ok(started.startedAt);

    await assert.rejects(() => startRun(run.id), InvalidRunTransitionError);
  } finally {
    await cleanupClient(client.id);
  }
});

test("recomputeRunCompletion: stays PROCESSING while any row is non-terminal", async () => {
  const client = await makeClient("State Test - completion in progress");
  try {
    const run = await makeRun(client.id, {
      status: "PROCESSING",
      totalRows: 2,
    });
    await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 8,
      rankDisplay: "8",
      sourceRowNumber: 2,
    });
    await makeRow(run.id, { status: "PENDING", sourceRowNumber: 3 });

    const result = await recomputeRunCompletion(run.id);
    assert.equal(result, null);

    const stillProcessing = await prisma.rankingRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    assert.equal(stillProcessing.status, "PROCESSING");
  } finally {
    await cleanupClient(client.id);
  }
});

test("recomputeRunCompletion: COMPLETED when all rows succeed", async () => {
  const client = await makeClient("State Test - all completed");
  try {
    const run = await makeRun(client.id, {
      status: "PROCESSING",
      totalRows: 2,
    });
    await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 8,
      rankDisplay: "8",
      sourceRowNumber: 2,
    });
    await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 14,
      rankDisplay: "14",
      sourceRowNumber: 3,
    });

    const result = await recomputeRunCompletion(run.id);
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.completedAt);
  } finally {
    await cleanupClient(client.id);
  }
});

test("recomputeRunCompletion: COMPLETED_WITH_ERRORS when any row FAILED", async () => {
  const client = await makeClient("State Test - completed with errors");
  try {
    const run = await makeRun(client.id, {
      status: "PROCESSING",
      totalRows: 2,
    });
    await makeRow(run.id, {
      status: "COMPLETED",
      rankValue: 8,
      rankDisplay: "8",
      sourceRowNumber: 2,
    });
    await makeRow(run.id, {
      status: "FAILED",
      retryCount: 3,
      maxRetries: 3,
      sourceRowNumber: 3,
    });

    const result = await recomputeRunCompletion(run.id);
    assert.equal(result.status, "COMPLETED_WITH_ERRORS");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cancelRun: UPLOADED or PROCESSING -> CANCELLED, terminal after that", async () => {
  const client = await makeClient("State Test - cancel");
  try {
    const run = await makeRun(client.id, { status: "PROCESSING" });
    const cancelled = await cancelRun(run.id);
    assert.equal(cancelled.status, "CANCELLED");

    await assert.rejects(() => cancelRun(run.id), InvalidRunTransitionError);
    await assert.rejects(() => startRun(run.id), InvalidRunTransitionError);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
