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

test("PATCH /api/reports/:id edits the draft while PENDING_APPROVAL: subject, body, and recipients all persist, and the response reflects them", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - patch ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app)
      .patch(`/api/reports/${report.id}`)
      .send({
        emailSubject: "Edited via API",
        emailBody: "Edited body text via API",
        resolvedRecipients: ["a@example.com", "b@example.com"],
      });

    assert.equal(res.status, 200);
    // Response contains the updated values -- the frontend doesn't have to
    // guess or re-fetch to know what was actually saved.
    assert.equal(res.body.emailSubject, "Edited via API");
    assert.equal(res.body.emailBody, "Edited body text via API");
    assert.deepEqual(res.body.resolvedRecipients, ["a@example.com", "b@example.com"]);
    assert.equal(res.body.status, "PENDING_APPROVAL", "editing must never move the report's state");

    // FIX #4 section 3's refresh test, at the API layer: a completely
    // separate GET (simulating a page refresh / re-navigation) must read
    // back the exact same persisted values, not whatever the PATCH request
    // merely echoed.
    const refetched = await request(app).get(`/api/reports/${report.id}`);
    assert.equal(refetched.status, 200);
    assert.equal(refetched.body.emailSubject, "Edited via API");
    assert.equal(refetched.body.emailBody, "Edited body text via API");
    assert.deepEqual(refetched.body.resolvedRecipients, ["a@example.com", "b@example.com"]);
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

test("PATCH /api/reports/:id rejects a malformed email address in resolvedRecipients with 400, and does not persist any of it", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - patch invalid email ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, ["original@example.com"]);

    const res = await request(app)
      .patch(`/api/reports/${report.id}`)
      .send({ resolvedRecipients: ["valid@example.com", "not-an-email"] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not-an-email/);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.deepEqual(unchanged.resolvedRecipients, ["original@example.com"], "a rejected PATCH must not partially apply");
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

test("POST /api/reports/:id/generate-email-draft works for a report built via the Build Report shortcut (no Claude Insights, analysisJson is null)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - email draft without insights ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        status: ReportStatus.REPORT_READY,
        analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
        clientPdfPath: "/reports/fake.pdf",
        // analysisJson intentionally left null -- this is what the report
        // looks like when Build Report ran directly off PENDING_ANALYSIS.
      },
    });

    const res = await request(app).post(`/api/reports/${report.id}/generate-email-draft`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "PENDING_APPROVAL");
    assert.ok(persisted.emailSubject);
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

test("POST /api/reports/:id/build-report drives PENDING_ANALYSIS -> REPORT_READY directly, generating one PDF artifact, no Claude Insights step required", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report from pending analysis ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");
    assert.ok(res.body.clientPdfPath);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "REPORT_READY");
    assert.ok(persisted.clientPdfPath, "the generated PDF path must be stored on the report");
    assert.equal(persisted.reportHtml, null, "the deterministic PDF path replaces the old HTML report -- no narrative HTML is generated");

    const pdfRes = await request(app).get(`/api/reports/${report.id}/pdf`);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers["content-type"], "application/pdf");
    assert.ok(pdfRes.body.length > 0, "the streamed PDF must be non-empty");
    assert.equal(pdfRes.body.slice(0, 4).toString("latin1"), "%PDF", "response body must be a real PDF file");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/build-report also works from ANALYSIS_READY (reports that already went through Insights)", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report from analysis ready ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makeAnalysisReadyReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "REPORT_READY");
    assert.ok(persisted.clientPdfPath);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/build-report rejects a report that's already past REPORT_READY (PENDING_APPROVAL) with 409", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report wrong state ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await request(app).post(`/api/reports/${report.id}/build-report`);
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

// FIX #2 regression test: Run Completed -> Analytics Preview -> Build
// Report -> (user navigates Back) -> Analytics Preview -> Build Report
// again. Must NOT produce an invalid-state error (e.g. the old
// "PENDING_ANALYSIS -> ANALYSIS_READY -- not in a valid current state"
// class of bug) -- Build Report is safe to re-enter, regenerates the PDF in
// place, and never creates a second RankingReport for the same run.
test("POST /api/reports/:id/build-report is safe to click again after Back: re-entering Analytics Preview and building again succeeds with no state error", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report re-entry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");

    // 1. Run Completed -> creating the report is itself idempotent per run
    // (createReportForRun reuses an existing report for the same runId).
    const created = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(created.status, 201);
    const reportId = created.body.report.id;

    // 2. Analytics Preview -> Build Report (first time).
    const first = await request(app).post(`/api/reports/${reportId}/build-report`);
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, "SUCCESS");
    const afterFirst = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
    assert.equal(afterFirst.status, "REPORT_READY");
    const firstPdfPath = afterFirst.clientPdfPath;
    assert.ok(firstPdfPath);

    // 3. User navigates Back to Analytics Preview (pure client-side nav --
    // nothing to simulate server-side; the report is untouched).
    const stillThere = await request(app).get(`/api/reports/${reportId}`);
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.status, "REPORT_READY");

    // 4. Re-creating a report for the same run must NOT create a duplicate.
    const againCreated = await request(app).post("/api/reports").send({ runId: run.id });
    assert.equal(againCreated.status, 409);
    assert.equal(againCreated.body.existingReportId, reportId);
    const allReportsForRun = await prisma.rankingReport.findMany({ where: { runId: run.id } });
    assert.equal(allReportsForRun.length, 1, "no duplicate RankingReport was created");

    // 5. Click Build Report again -- must succeed, not throw an invalid
    // state-transition error, and must not touch analyticsJson (no re-run
    // of analytics/Claude/DataForSEO).
    const second = await request(app).post(`/api/reports/${reportId}/build-report`);
    assert.equal(second.status, 200);
    assert.equal(second.body.outcome, "SUCCESS");

    const afterSecond = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
    assert.equal(afterSecond.status, "REPORT_READY");
    assert.deepEqual(afterSecond.analyticsJson, afterFirst.analyticsJson, "analytics were not recomputed");
    assert.equal(afterSecond.clientPdfPath, firstPdfPath, "same stored path -- the artifact was regenerated in place, not duplicated");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/build-report double-click / concurrent race: both requests succeed, no duplicate-transition error", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - build report concurrent ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);

    const [first, second] = await Promise.all([
      request(app).post(`/api/reports/${report.id}/build-report`),
      request(app).post(`/api/reports/${report.id}/build-report`),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, "REPORT_READY");
    assert.ok(persisted.clientPdfPath);
  } finally {
    await cleanupClient(client.id);
  }
});

test("GET /api/reports/:id/pdf returns 404 before the report has been built", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Reports API Test - pdf not built yet ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, "COMPLETED");
    const report = await makePendingAnalysisReport(client.id, run.id);

    const res = await request(app).get(`/api/reports/${report.id}/pdf`);
    assert.equal(res.status, 404);
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
