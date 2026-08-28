import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { createMockClaudeAnalyst, createMockClaudeEmailDrafter } from "../backend/reporting/mockClaudeClient.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Full HTTP-layer test against the real local Postgres container. Both
// Claude and the email provider are mocked -- no real calls of any kind.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string, status: "UPLOADED" | "PROCESSING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "CANCELLED" = "COMPLETED") {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "reports-api-test.xlsx",
      sourceFilePath: "local-test/reports-api-test.xlsx",
      totalRows: 1,
      status,
      completedAt: status === "COMPLETED" || status === "COMPLETED_WITH_ERRORS" ? new Date() : null,
    },
  });
}

async function makePendingApprovalReport(clientId: string, runId: string, recipients: string[] = ["ops@example.com"]) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.PENDING_APPROVAL,
      analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
      analysisJson: { overallNarrative: "ok", keyInsights: [], notableWins: [], notableLosses: [], recommendedFocusAreas: [] },
      reportHtml: "<html>report</html>",
      emailSubject: "Your ranking update",
      emailBody: "Here is your update.",
      resolvedRecipients: recipients,
    },
  });
}

async function makePendingAnalysisReport(clientId: string, runId: string, previousRunId?: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      previousRunId,
      status: ReportStatus.PENDING_ANALYSIS,
      analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
    },
  });
}

async function makeAnalysisReadyReport(clientId: string, runId: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.ANALYSIS_READY,
      analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
      analysisJson: { overallNarrative: "ok", keyInsights: [], notableWins: [], notableLosses: [], recommendedFocusAreas: [] },
    },
  });
}

async function makeReportReadyReport(clientId: string, runId: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.REPORT_READY,
      analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
      analysisJson: { overallNarrative: "ok", keyInsights: [], notableWins: [], notableLosses: [], recommendedFocusAreas: [] },
      reportHtml: "<html>report</html>",
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("GET /api/reports/:id returns the full preview", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - preview ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).get(`/api/reports/${report.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "PENDING_APPROVAL");
    assert.equal(res.body.reportHtml, "<html>report</html>");
    assert.equal(res.body.client.id, client.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/reports/:id returns 404 for an unknown report", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).get(`/api/reports/${randomUUID()}`);
  assert.equal(res.status, 404);
});

test("PATCH /api/reports/:id edits the draft while PENDING_APPROVAL", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - patch ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app)
      .patch(`/api/reports/${report.id}`)
      .send({ emailSubject: "Edited via API", resolvedRecipients: ["a@example.com", "b@example.com"] });

    assert.equal(res.status, 200);
    assert.equal(res.body.emailSubject, "Edited via API");
    assert.deepEqual(res.body.resolvedRecipients, ["a@example.com", "b@example.com"]);
  } finally {
    await cleanupClient(client.id);
  }
});

test("PATCH /api/reports/:id rejects a non-array resolvedRecipients with 400", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - patch bad input ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).patch(`/api/reports/${report.id}`).send({ resolvedRecipients: "not-an-array@example.com" });
    assert.equal(res.status, 400);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/approve-and-send sends via the injected mock sender, and rejects a second call", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    callClaudeAnalyst: createMockClaudeAnalyst(),
    callClaudeEmailDraft: createMockClaudeEmailDrafter(),
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const client = await makeClient(`Reports API Test - approve send ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const first = await request(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "om@syspreedigital.com" });
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, "SENT");
    assert.equal(sentCalls.length, 1);

    const second = await request(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "om@syspreedigital.com" });
    assert.equal(second.status, 409);
    assert.equal(second.body.outcome, "ALREADY_PROCESSED");
    assert.equal(sentCalls.length, 1); // still only one send
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/approve-and-send requires approvedBy", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - missing approvedBy ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(res.status, 400);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/approve-and-send returns 422 when there are no recipients", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - no recipients ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, []);

    const res = await request(app).post(`/api/reports/${report.id}/approve-and-send`).send({ approvedBy: "om@syspreedigital.com" });
    assert.equal(res.status, 422);
    assert.equal(res.body.outcome, "NO_RECIPIENTS");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/reject transitions to REJECTED", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - reject ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/reject`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "REJECTED");

    const again = await request(app).post(`/api/reports/${report.id}/reject`);
    assert.equal(again.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/regenerate produces a fresh draft via the injected mock Claude client", async () => {
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    callClaudeAnalyst: createMockClaudeAnalyst(),
    callClaudeEmailDraft: createMockClaudeEmailDrafter(),
    sendEmail: createMockEmailSender(),
  });
  const client = await makeClient(`Reports API Test - regenerate ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/regenerate`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "PENDING_APPROVAL");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports creates a report at PENDING_ANALYSIS with analytics eagerly computed, but does not call Claude", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - create success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");

    const res = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.report.runId, run.id);
    assert.equal(res.body.report.clientId, client.id);
    assert.equal(res.body.report.status, "PENDING_ANALYSIS");
    assert.ok(res.body.report.analyticsJson, "analytics should be eagerly computed at creation");
    assert.equal(res.body.report.analysisJson, null, "Claude has not been called yet");
    assert.equal(res.body.report.reportHtml, null);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: res.body.report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_ANALYSIS);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports accepts an explicit previousRunId for comparison", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - explicit previous run ${randomUUID()}`);
  try {
    const olderRun = await makeRun(client.id, "COMPLETED");
    const run = await makeRun(client.id, "COMPLETED");

    const res = await request(app).post("/api/reports").send({ runId: run.id, previousRunId: olderRun.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.report.previousRunId, olderRun.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports rejects an unknown run with 404", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).post("/api/reports").send({ runId: randomUUID() });
  assert.equal(res.status, 404);
});

test("POST /api/reports rejects an incomplete run (still PROCESSING) with 409", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - create incomplete run ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "PROCESSING");

    const res = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /PROCESSING/);

    const reports = await prisma.rankingReport.findMany({ where: { runId: run.id } });
    assert.equal(reports.length, 0);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports requires a runId", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).post("/api/reports").send({});
  assert.equal(res.status, 400);
});

test("POST /api/reports rejects a duplicate report for the same run with 409, without touching the existing report", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - create duplicate ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");

    const first = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(first.status, 201);

    const second = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.existingReportId, first.body.report.id);

    const reports = await prisma.rankingReport.findMany({ where: { runId: run.id } });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, first.body.report.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/generate-email-draft drives REPORT_READY -> PENDING_APPROVAL via the mock Claude client", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - generate email draft ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makeReportReadyReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/generate-email-draft`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "PENDING_APPROVAL");
    assert.ok(persisted.emailSubject);
    assert.ok(persisted.emailBody);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/generate-email-draft rejects a report that isn't REPORT_READY with 409", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - generate email draft wrong state ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/generate-email-draft`);
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/generate-insights drives PENDING_ANALYSIS -> ANALYSIS_READY via the mock Claude client, without building the report", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - generate insights ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/generate-insights`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "ANALYSIS_READY");
    assert.ok(persisted.analysisJson);
    assert.equal(persisted.reportHtml, null, "build-report is a separate step");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/generate-insights rejects a report that isn't PENDING_ANALYSIS with 409", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - generate insights wrong state ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makeAnalysisReadyReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/generate-insights`);
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/build-report drives ANALYSIS_READY -> REPORT_READY deterministically", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makeAnalysisReadyReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");
    assert.ok(res.body.reportHtml.includes(client.name));

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "REPORT_READY");
    assert.ok(persisted.reportHtml);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/build-report rejects a report that isn't ANALYSIS_READY with 409", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report wrong state ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/reports?clientId= lists only that client's reports, most recent first", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - list ${randomUUID()}`);
  const otherClient = await makeClient(`Reports API Test - list other client ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);
    const otherRun = await makeRun(otherClient.id, "COMPLETED");
    await makePendingAnalysisReport(otherClient.id, otherRun.id);

    const res = await request(app).get(`/api/reports?clientId=${client.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, report.id);
    assert.equal(res.body[0].run.id, run.id);
  } finally {
    await cleanupClient(client.id);
    await cleanupClient(otherClient.id);
  }
});

test("GET /api/reports requires a clientId query parameter", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).get("/api/reports");
  assert.equal(res.status, 400);
});

test.after(async () => {
  await prisma.$disconnect();
});
