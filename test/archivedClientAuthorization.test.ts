import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";

// Phase 4: archived/inactive clients must keep their historical data
// readable, but no new run/report generation, editing, approval, sending,
// regeneration, or other mutating workflow action may be performed for
// them -- enforced server-side (backend/auth/ownership.ts's requireActive
// option), never relying on the frontend simply not offering them in a
// dropdown.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});

function authedApp(app: ReturnType<typeof createApp>) {
  return authedRequest(app, auth.cookieHeader);
}

function tinyExcelBuffer(): Buffer {
  return Buffer.from("not a real xlsx, never parsed");
}

async function makeClient(name: string, flags: { isActive?: boolean; archivedAt?: Date | null } = {}) {
  return prisma.client.create({
    data: { name, workspaceId: auth.workspace.id, isActive: flags.isActive ?? true, archivedAt: flags.archivedAt ?? null },
  });
}

async function makeRun(clientId: string, status: "UPLOADED" | "COMPLETED" = "COMPLETED") {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "archived-client-test.xlsx",
      sourceFilePath: "local-test/archived-client-test.xlsx",
      totalRows: 1,
      status,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });
}

async function makePendingApprovalReport(clientId: string, runId: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.PENDING_APPROVAL,
      analyticsJson: { totals: { totalKeywords: 1 } },
      emailSubject: "Subject",
      emailBody: "Body",
      resolvedRecipients: ["ops@example.com"],
      clientPdfPath: "/reports/fake.pdf",
    },
  });
}

async function cleanupClient(clientId: string) {
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("archived client: cannot create, validate, or start a new run (-> 409, nothing created)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Archived Test - new run ${randomUUID()}`, { archivedAt: new Date() });
  try {
    const createRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", tinyExcelBuffer(), "test.xlsx");
    assert.equal(createRes.status, 409);

    const validateRes = await authedApp(app).post("/api/runs/validate").field("clientId", client.id).attach("file", tinyExcelBuffer(), "test.xlsx");
    assert.equal(validateRes.status, 409);

    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    assert.equal(runs.length, 0, "no run may be created for an archived client");
  } finally {
    await cleanupClient(client.id);
  }
});

test("archived client: an existing run cannot be started or cancelled (-> 409, run left untouched), but reads still work", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Archived Test - start cancel ${randomUUID()}`, { archivedAt: new Date() });
  try {
    const run = await makeRun(client.id, "UPLOADED");

    const startRes = await authedApp(app).post(`/api/runs/${run.id}/start`);
    assert.equal(startRes.status, 409);
    const cancelRes = await authedApp(app).post(`/api/runs/${run.id}/cancel`);
    assert.equal(cancelRes.status, 409);

    const untouched = await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(untouched.status, "UPLOADED");

    // Historical read-only access remains available.
    const viewRes = await authedApp(app).get(`/api/runs/${run.id}`);
    assert.equal(viewRes.status, 200);
    const listRes = await authedApp(app).get(`/api/runs?clientId=${client.id}`);
    assert.equal(listRes.status, 200);
  } finally {
    await cleanupClient(client.id);
  }
});

test("archived client: cannot create a report from its run (-> 409, nothing created)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Archived Test - create report ${randomUUID()}`, { archivedAt: new Date() });
  try {
    const run = await makeRun(client.id);
    const res = await authedApp(app).post("/api/reports").send({ runId: run.id });
    assert.equal(res.status, 409);

    const reports = await prisma.rankingReport.findMany({ where: { runId: run.id } });
    assert.equal(reports.length, 0);
  } finally {
    await cleanupClient(client.id);
  }
});

test("archived client: cannot build, edit, reject, regenerate, or draft-email an existing report (all -> 409, no state change), but reads still work", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Archived Test - other actions ${randomUUID()}`, { archivedAt: new Date() });
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const buildRes = await authedApp(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(buildRes.status, 409);

    const editRes = await authedApp(app).patch(`/api/reports/${report.id}`).send({ emailSubject: "Should not apply" });
    assert.equal(editRes.status, 409);

    const rejectRes = await authedApp(app).post(`/api/reports/${report.id}/reject`);
    assert.equal(rejectRes.status, 409);

    const regenRes = await authedApp(app).post(`/api/reports/${report.id}/regenerate`);
    assert.equal(regenRes.status, 409);

    const draftRes = await authedApp(app).post(`/api/reports/${report.id}/generate-email-draft`);
    assert.equal(draftRes.status, 409);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, ReportStatus.PENDING_APPROVAL);
    assert.equal(unchanged.emailSubject, "Subject");

    // Historical read-only access remains available.
    const viewRes = await authedApp(app).get(`/api/reports/${report.id}`);
    assert.equal(viewRes.status, 200);
    const pdfRes = await authedApp(app).get(`/api/reports/${report.id}/pdf`);
    assert.equal(pdfRes.status, 404); // no real PDF on disk in this fixture -- 404 for a MISSING file, not 409 for archived; proves the archived check isn't blocking the read path at all
    const listRes = await authedApp(app).get(`/api/reports?clientId=${client.id}`);
    assert.equal(listRes.status, 200);
  } finally {
    await cleanupClient(client.id);
  }
});

test("archived client: approve-and-send is refused (-> 409), and the send function is never invoked", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Archived Test - approve send ${randomUUID()}`, { archivedAt: new Date() });
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "someone@example.com" });
    assert.equal(res.status, 409);
    assert.equal(sentCalls.length, 0, "the send function must never be called for an archived client's report");

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, ReportStatus.PENDING_APPROVAL);
  } finally {
    await cleanupClient(client.id);
  }
});

test("inactive (deactivated, not archived) client: same enforcement -- isActive:false alone is enough to block mutating actions", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Inactive Test - approve send ${randomUUID()}`, { isActive: false });
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const createRunRes = await authedApp(app).post("/api/runs").field("clientId", client.id).attach("file", tinyExcelBuffer(), "test.xlsx");
    assert.equal(createRunRes.status, 409);

    const sendRes = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "someone@example.com" });
    assert.equal(sendRes.status, 409);
    assert.equal(sentCalls.length, 0);

    // Historical read-only access remains available.
    const viewRes = await authedApp(app).get(`/api/reports/${report.id}`);
    assert.equal(viewRes.status, 200);
  } finally {
    await cleanupClient(client.id);
  }
});

test("active, non-archived client: every mutating action continues working normally (no regression)", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Active Test - full flow ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const editRes = await authedApp(app).patch(`/api/reports/${report.id}`).send({ emailSubject: "Edited" });
    assert.equal(editRes.status, 200);

    const sendRes = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "someone@example.com" });
    assert.equal(sendRes.status, 200);
    assert.equal(sentCalls.length, 1);
  } finally {
    await cleanupClient(client.id);
  }
});
