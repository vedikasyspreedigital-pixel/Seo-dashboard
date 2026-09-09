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

// Dedicated cross-workspace authorization audit. Every route in runs.ts/
// reports.ts that accepts a clientId/runId/reportId (path, query, or body)
// must 404 -- never leak existence, never partially apply -- when the
// caller's session belongs to a DIFFERENT workspace than the resource.
// Named after the app's two real workspaces (SEO / Advanced SEO) purely for
// readability; these use freshly created test workspaces, never the real
// "seo"/"advanced-seo" slugs already present in a real dev database.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

let seoAuth: AuthFixture; // "SEO" workspace -- the attacker/unrelated user in every test below
let advancedSeoAuth: AuthFixture; // "Advanced SEO" workspace -- owns every fixture below

test.before(async () => {
  seoAuth = await createAuthenticatedSession();
  advancedSeoAuth = await createAuthenticatedSession();
});
test.after(async () => {
  await seoAuth.cleanup();
  await advancedSeoAuth.cleanup();
  await prisma.$disconnect();
});

function seoApp(app: ReturnType<typeof createApp>) {
  return authedRequest(app, seoAuth.cookieHeader);
}
function advancedSeoApp(app: ReturnType<typeof createApp>) {
  return authedRequest(app, advancedSeoAuth.cookieHeader);
}

function tinyExcelBuffer(): Buffer {
  // Content is irrelevant -- every test below expects the ownership check to
  // 404 before the file is ever parsed. Just needs to exist so the routes'
  // upfront "clientId and file are required" 400 doesn't fire first.
  return Buffer.from("not a real xlsx, never parsed");
}

async function makeClient(name: string) {
  return prisma.client.create({ data: { name, workspaceId: advancedSeoAuth.workspace.id } });
}

async function makeRun(clientId: string, status: "UPLOADED" | "COMPLETED" = "COMPLETED") {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "workspace-auth-test.xlsx",
      sourceFilePath: "local-test/workspace-auth-test.xlsx",
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

test("cross-workspace: SEO user cannot view an Advanced SEO run (GET /api/runs/:id -> 404), same-workspace access still works", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - view run ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const res = await seoApp(app).get(`/api/runs/${run.id}`);
    assert.equal(res.status, 404);

    const ownerRes = await advancedSeoApp(app).get(`/api/runs/${run.id}`);
    assert.equal(ownerRes.status, 200, "the legitimate owner's own access must be unaffected by the fix");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot export an Advanced SEO run (GET /api/runs/:id/export -> 404)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - export run ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const res = await seoApp(app).get(`/api/runs/${run.id}/export`);
    assert.equal(res.status, 404);
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot view an Advanced SEO run's rows or progress (-> 404)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - rows progress ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const rowsRes = await seoApp(app).get(`/api/runs/${run.id}/rows`);
    assert.equal(rowsRes.status, 404);
    const progressRes = await seoApp(app).get(`/api/runs/${run.id}/progress`);
    assert.equal(progressRes.status, 404);
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot start or cancel an Advanced SEO run (-> 404, run left untouched)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - start cancel ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "UPLOADED");

    const startRes = await seoApp(app).post(`/api/runs/${run.id}/start`);
    assert.equal(startRes.status, 404);
    const cancelRes = await seoApp(app).post(`/api/runs/${run.id}/cancel`);
    assert.equal(cancelRes.status, 404);

    const untouched = await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(untouched.status, "UPLOADED", "neither rejected call may change run state");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: a foreign clientId is rejected for run creation, validation, and listing (-> 404, nothing created)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - foreign clientId ${randomUUID()}`);
  try {
    const listRes = await seoApp(app).get(`/api/runs?clientId=${client.id}`);
    assert.equal(listRes.status, 404);

    const createRes = await seoApp(app).post("/api/runs").field("clientId", client.id).attach("file", tinyExcelBuffer(), "test.xlsx");
    assert.equal(createRes.status, 404);

    const validateRes = await seoApp(app).post("/api/runs/validate").field("clientId", client.id).attach("file", tinyExcelBuffer(), "test.xlsx");
    assert.equal(validateRes.status, 404);

    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    assert.equal(runs.length, 0, "the rejected create attempt must not have created a run");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot create a report from an Advanced SEO run (POST /api/reports -> 404, nothing created)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - create report ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const res = await seoApp(app).post("/api/reports").send({ runId: run.id });
    assert.equal(res.status, 404);

    const reports = await prisma.rankingReport.findMany({ where: { runId: run.id } });
    assert.equal(reports.length, 0, "no report must be created from the rejected attempt");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: previousRunId is validated too -- a report cannot be created diffed against a foreign run", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const seoClient = await prisma.client.create({
    data: { name: `Workspace Auth Test - seo own client ${randomUUID()}`, workspaceId: seoAuth.workspace.id },
  });
  const foreignClient = await makeClient(`Workspace Auth Test - foreign previous run ${randomUUID()}`);
  try {
    const foreignRun = await makeRun(foreignClient.id);
    const ownRun = await prisma.rankingRun.create({
      data: {
        clientId: seoClient.id,
        sourceFilename: "workspace-auth-test.xlsx",
        sourceFilePath: "local-test/workspace-auth-test.xlsx",
        totalRows: 1,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    const res = await seoApp(app).post("/api/reports").send({ runId: ownRun.id, previousRunId: foreignRun.id });
    assert.equal(res.status, 404);

    const reports = await prisma.rankingReport.findMany({ where: { runId: ownRun.id } });
    assert.equal(reports.length, 0, "a foreign previousRunId must block report creation entirely, not just be ignored");
  } finally {
    await cleanupClient(seoClient.id);
    await cleanupClient(foreignClient.id);
  }
});

test("cross-workspace: SEO user cannot list reports for an Advanced SEO client (GET /api/reports?clientId= -> 404)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - list reports ${randomUUID()}`);
  try {
    const res = await seoApp(app).get(`/api/reports?clientId=${client.id}`);
    assert.equal(res.status, 404);
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot view or edit an Advanced SEO report (-> 404, no partial write), same-workspace access still works", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - view edit report ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const viewRes = await seoApp(app).get(`/api/reports/${report.id}`);
    assert.equal(viewRes.status, 404);

    const editRes = await seoApp(app).patch(`/api/reports/${report.id}`).send({ emailSubject: "Hijacked subject" });
    assert.equal(editRes.status, 404);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.emailSubject, "Subject", "the rejected cross-workspace PATCH must not modify anything");

    const ownerRes = await advancedSeoApp(app).get(`/api/reports/${report.id}`);
    assert.equal(ownerRes.status, 200, "the legitimate owner's own access must be unaffected by the fix");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user's approve-and-send on an Advanced SEO report 404s, and the send function is never invoked", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Workspace Auth Test - approve send ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await seoApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "attacker@example.com" });
    assert.equal(res.status, 404);
    assert.equal(sentCalls.length, 0, "the send function must never be called for a report outside the caller's workspace");

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, "PENDING_APPROVAL", "the report must not be approved/sent by the rejected attempt");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: SEO user cannot reject, build, get the PDF of, regenerate, or draft-email an Advanced SEO report (all -> 404, no state change)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Workspace Auth Test - other actions ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const rejectRes = await seoApp(app).post(`/api/reports/${report.id}/reject`);
    assert.equal(rejectRes.status, 404);

    const buildRes = await seoApp(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(buildRes.status, 404);

    const pdfRes = await seoApp(app).get(`/api/reports/${report.id}/pdf`);
    assert.equal(pdfRes.status, 404);

    const regenRes = await seoApp(app).post(`/api/reports/${report.id}/regenerate`);
    assert.equal(regenRes.status, 404);

    const draftRes = await seoApp(app).post(`/api/reports/${report.id}/generate-email-draft`);
    assert.equal(draftRes.status, 404);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, "PENDING_APPROVAL", "none of the rejected cross-workspace calls may change report state");
  } finally {
    await cleanupClient(client.id);
  }
});

test("cross-workspace: same-workspace access continues working end-to-end (view -> approve-and-send) after the authorization fix", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Workspace Auth Test - legit owner flow ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const viewRes = await advancedSeoApp(app).get(`/api/reports/${report.id}`);
    assert.equal(viewRes.status, 200);

    const sendRes = await advancedSeoApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "owner@example.com" });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.outcome, "SENT");
    assert.equal(sentCalls.length, 1, "the legitimate owner's send must go through normally");
  } finally {
    await cleanupClient(client.id);
  }
});
