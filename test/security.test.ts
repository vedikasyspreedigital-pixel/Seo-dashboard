import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { hashPassword } from "../backend/auth/password.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

// Covers the two scoped security fixes from the post-launch review: login
// rate limiting (brute-force protection) and magic-byte validation on the
// ranking Excel upload (previously accepted any file up to 25MB with zero
// content check). Each rate limiter is a module-level singleton (see
// backend/api/rateLimit.ts), so this file's login-attempt count only
// matters relative to itself -- Node's test runner isolates each listed
// test file into its own process, so no other file's login attempts share
// this counter.

test("POST /api/auth/login: rate-limits repeated failed attempts instead of allowing unlimited brute-forcing", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const email = `ratelimit-test-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: hashPassword("the-real-password") } });

  try {
    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password: "wrong-password" });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    assert.equal(lastStatus, 429, "expected the rate limiter to eventually reject repeated attempts with 429");
  } finally {
    await prisma.user.delete({ where: { email } });
  }
});

test("POST /api/runs: rejects a file that isn't actually a valid .xlsx (wrong magic bytes), even with an .xlsx filename", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Xlsx Magic Byte Test - ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const fakeXlsx = Buffer.from("this is just plain text, not a real xlsx file");
    const res = await authedRequest(app, auth.cookieHeader)
      .post("/api/runs")
      .field("clientId", client.id)
      .attach("file", fakeXlsx, "totally-real.xlsx");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /valid \.xlsx/i);

    const runCount = await prisma.rankingRun.count({ where: { clientId: client.id } });
    assert.equal(runCount, 0, "nothing should be created for a rejected file");
  } finally {
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test("POST /api/runs: a genuinely valid .xlsx file still passes the magic-byte check (not a false positive)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Xlsx Magic Byte Valid Test - ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["Keywords", "Full URL", "URL", "Concatenate", "Location", "Domain", "Language", "Status", "Ranks", "Ranking URL"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await authedRequest(app, auth.cookieHeader).post("/api/runs").field("clientId", client.id).attach("file", buffer, "real.xlsx");
    // Not asserting 201 specifically -- an empty sheet may fail later
    // validation for unrelated reasons. What matters here is that it's
    // NOT rejected for the magic-byte reason.
    if (res.status === 400) {
      assert.doesNotMatch(res.body.error ?? "", /valid \.xlsx/i);
    }
  } finally {
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test("POST /api/runs: a file with a valid zip signature but corrupted/malformed content beyond that returns 400, not a crash", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Malformed Xlsx Test - ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    // Passes the magic-byte check (real zip signature) but is otherwise
    // garbage -- ExcelJS's own parser must reject this, not the app crash
    // trying to read it. Real-world equivalent: a truncated/corrupted
    // upload from a flaky connection.
    const corrupted = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not a real zip central directory, just garbage bytes".repeat(20))]);
    const res = await authedRequest(app, auth.cookieHeader).post("/api/runs").field("clientId", client.id).attach("file", corrupted, "corrupted.xlsx");

    assert.equal(res.status, 400, "a malformed file must fail cleanly with 400, never a 500 or a hang");
    const runCount = await prisma.rankingRun.count({ where: { clientId: client.id } });
    assert.equal(runCount, 0, "nothing should be created for a file that failed to parse");

    // The server process itself must still be alive and responsive --
    // proves the malformed upload didn't crash/hang the whole app.
    const health = await request(app).get("/api/health");
    assert.equal(health.status, 200);
  } finally {
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test("POST /api/runs: a rapid duplicate submission (same client + same filename, seconds apart) does not create a second run", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Duplicate Run Test - ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["Keywords", "Full URL", "URL", "Concatenate", "Location", "Domain", "Language", "Status", "Ranks", "Ranking URL"]);
    sheet.addRow(["test keyword", "example.com", "*example.*", "x", "Australia", "google.com.au", "English", "Pending", "", ""]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const first = await authedRequest(app, auth.cookieHeader).post("/api/runs").field("clientId", client.id).attach("file", buffer, "dup-test.xlsx");
    assert.equal(first.status, 201);

    // Simulates a double-click / retried request landing moments later.
    const second = await authedRequest(app, auth.cookieHeader).post("/api/runs").field("clientId", client.id).attach("file", buffer, "dup-test.xlsx");
    assert.equal(second.status, 200, "a near-duplicate submission resolves to the existing run (200), not a second 201");
    assert.equal(second.body.run.id, first.body.run.id, "must return the SAME run, not create a new one");

    const runCount = await prisma.rankingRun.count({ where: { clientId: client.id, sourceFilename: "dup-test.xlsx" } });
    assert.equal(runCount, 1, "exactly one run must exist for this upload, not two");
  } finally {
    await prisma.rankingRow.deleteMany({ where: { run: { clientId: client.id } } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
