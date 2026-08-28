import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import {
  isValidReportTransition,
  markAnalysisReady,
  markAnalysisFailed,
  retryAnalysis,
  markReportReady,
  markEmailDrafted,
  markEmailDraftFailed,
  retryEmailDraft,
  submitForApproval,
  approveReport,
  rejectReport,
  markSent,
} from "../backend/reporting/reportTransitions.js";
import { InvalidReportTransitionError } from "../backend/reporting/errors.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433). Exercises only ranking_reports
// -- no ranking worker/state-machine code (RunStatus/RowStatus) is touched.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "report-transitions-test.xlsx",
      sourceFilePath: "local-test/report-transitions-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
    },
  });
}

async function makeReport(clientId: string, runId: string, overrides: Partial<{ status: ReportStatus }> = {}) {
  return prisma.rankingReport.create({
    data: { clientId, runId, ...overrides },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("report transition graph matches the locked design", () => {
  assert.equal(isValidReportTransition(ReportStatus.PENDING_ANALYSIS, ReportStatus.ANALYSIS_READY), true);
  assert.equal(isValidReportTransition(ReportStatus.PENDING_ANALYSIS, ReportStatus.ANALYSIS_FAILED), true);
  assert.equal(isValidReportTransition(ReportStatus.ANALYSIS_FAILED, ReportStatus.PENDING_ANALYSIS), true);
  assert.equal(isValidReportTransition(ReportStatus.ANALYSIS_READY, ReportStatus.REPORT_READY), true);
  assert.equal(isValidReportTransition(ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFTED), true);
  assert.equal(isValidReportTransition(ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFT_FAILED), true);
  assert.equal(isValidReportTransition(ReportStatus.EMAIL_DRAFT_FAILED, ReportStatus.REPORT_READY), true);
  assert.equal(isValidReportTransition(ReportStatus.EMAIL_DRAFTED, ReportStatus.PENDING_APPROVAL), true);
  assert.equal(isValidReportTransition(ReportStatus.PENDING_APPROVAL, ReportStatus.APPROVED), true);
  assert.equal(isValidReportTransition(ReportStatus.PENDING_APPROVAL, ReportStatus.REJECTED), true);
  assert.equal(isValidReportTransition(ReportStatus.APPROVED, ReportStatus.SENT), true);

  // No skipping states, no illegal reversals, terminal states have no exits.
  assert.equal(isValidReportTransition(ReportStatus.PENDING_ANALYSIS, ReportStatus.PENDING_APPROVAL), false);
  assert.equal(isValidReportTransition(ReportStatus.EMAIL_DRAFTED, ReportStatus.REPORT_READY), false);
  assert.equal(isValidReportTransition(ReportStatus.SENT, ReportStatus.PENDING_ANALYSIS), false);
  assert.equal(isValidReportTransition(ReportStatus.REJECTED, ReportStatus.PENDING_ANALYSIS), false);
});

test("happy path: PENDING_ANALYSIS -> ... -> SENT, every field set at the right step", async () => {
  const client = await makeClient(`Report Transitions - happy path ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    assert.equal(report.status, ReportStatus.PENDING_ANALYSIS);

    const analysisReady = await markAnalysisReady(report.id, {
      analyticsJson: { totals: { totalKeywords: 5 } },
      analysisJson: { overallNarrative: "Solid week." },
    });
    assert.equal(analysisReady.status, ReportStatus.ANALYSIS_READY);
    assert.deepEqual(analysisReady.analyticsJson, { totals: { totalKeywords: 5 } });

    const reportReady = await markReportReady(report.id, { reportHtml: "<html>report</html>" });
    assert.equal(reportReady.status, ReportStatus.REPORT_READY);
    assert.equal(reportReady.reportHtml, "<html>report</html>");

    const emailDrafted = await markEmailDrafted(report.id, {
      emailSubject: "Your weekly ranking update",
      emailBody: "Here's how things went...",
      resolvedRecipients: ["ops@example.com"],
    });
    assert.equal(emailDrafted.status, ReportStatus.EMAIL_DRAFTED);
    assert.deepEqual(emailDrafted.resolvedRecipients, ["ops@example.com"]);

    const pendingApproval = await submitForApproval(report.id);
    assert.equal(pendingApproval.status, ReportStatus.PENDING_APPROVAL);

    const approved = await approveReport(report.id, { approvedBy: "om@syspreedigital.com" });
    assert.equal(approved.status, ReportStatus.APPROVED);
    assert.equal(approved.approvedBy, "om@syspreedigital.com");
    assert.ok(approved.approvedAt);

    const sent = await markSent(report.id);
    assert.equal(sent.status, ReportStatus.SENT);
    assert.ok(sent.sentAt);
  } finally {
    await cleanupClient(client.id);
  }
});

test("analysis failure/retry path: PENDING_ANALYSIS -> ANALYSIS_FAILED -> PENDING_ANALYSIS -> ANALYSIS_READY", async () => {
  const client = await makeClient(`Report Transitions - analysis retry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);

    const failed = await markAnalysisFailed(report.id, { errorMessage: "Claude returned an invalid schema" });
    assert.equal(failed.status, ReportStatus.ANALYSIS_FAILED);
    assert.equal(failed.lastErrorMessage, "Claude returned an invalid schema");

    const retried = await retryAnalysis(report.id);
    assert.equal(retried.status, ReportStatus.PENDING_ANALYSIS);
    assert.equal(retried.lastErrorMessage, null); // cleared on retry

    const ready = await markAnalysisReady(report.id, { analyticsJson: {}, analysisJson: {} });
    assert.equal(ready.status, ReportStatus.ANALYSIS_READY);
  } finally {
    await cleanupClient(client.id);
  }
});

test("email draft failure/retry path: REPORT_READY -> EMAIL_DRAFT_FAILED -> REPORT_READY -> EMAIL_DRAFTED", async () => {
  const client = await makeClient(`Report Transitions - email retry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, { status: ReportStatus.REPORT_READY });

    const failed = await markEmailDraftFailed(report.id, { errorMessage: "Model timeout" });
    assert.equal(failed.status, ReportStatus.EMAIL_DRAFT_FAILED);
    assert.equal(failed.lastErrorMessage, "Model timeout");

    const retried = await retryEmailDraft(report.id);
    assert.equal(retried.status, ReportStatus.REPORT_READY);
    assert.equal(retried.lastErrorMessage, null);

    const drafted = await markEmailDrafted(report.id, {
      emailSubject: "Subject",
      emailBody: "Body",
      resolvedRecipients: ["a@example.com"],
    });
    assert.equal(drafted.status, ReportStatus.EMAIL_DRAFTED);
  } finally {
    await cleanupClient(client.id);
  }
});

test("reject path: PENDING_APPROVAL -> REJECTED is terminal", async () => {
  const client = await makeClient(`Report Transitions - reject ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, { status: ReportStatus.PENDING_APPROVAL });

    const rejected = await rejectReport(report.id);
    assert.equal(rejected.status, ReportStatus.REJECTED);

    await assert.rejects(() => approveReport(report.id, { approvedBy: "x" }), InvalidReportTransitionError);
    await assert.rejects(() => submitForApproval(report.id), InvalidReportTransitionError);
  } finally {
    await cleanupClient(client.id);
  }
});

test("invalid transitions are rejected: can't skip states, can't act on terminal reports", async () => {
  const client = await makeClient(`Report Transitions - invalid ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);

    const freshReport = await makeReport(client.id, run.id); // PENDING_ANALYSIS
    await assert.rejects(() => markReportReady(freshReport.id, { reportHtml: "x" }), InvalidReportTransitionError);
    await assert.rejects(() => submitForApproval(freshReport.id), InvalidReportTransitionError);
    await assert.rejects(() => approveReport(freshReport.id, { approvedBy: "x" }), InvalidReportTransitionError);

    const sentReport = await makeReport(client.id, run.id, { status: ReportStatus.SENT });
    await assert.rejects(() => markSent(sentReport.id), InvalidReportTransitionError);
    await assert.rejects(() => rejectReport(sentReport.id), InvalidReportTransitionError);
    await assert.rejects(() => retryAnalysis(sentReport.id), InvalidReportTransitionError);

    const rejectedReport = await makeReport(client.id, run.id, { status: ReportStatus.REJECTED });
    await assert.rejects(() => submitForApproval(rejectedReport.id), InvalidReportTransitionError);
  } finally {
    await cleanupClient(client.id);
  }
});

test("concurrent markAnalysisReady on the same report: exactly one winner, no corruption", async () => {
  const client = await makeClient(`Report Transitions - concurrency ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);

    const results = await Promise.allSettled([
      markAnalysisReady(report.id, { analyticsJson: { from: "A" }, analysisJson: {} }),
      markAnalysisReady(report.id, { analyticsJson: { from: "B" }, analysisJson: {} }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof InvalidReportTransitionError);

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.ANALYSIS_READY);
  } finally {
    await cleanupClient(client.id);
  }
});

test("foreign key: a run with an existing report cannot be deleted until the report is removed", async () => {
  const client = await makeClient(`Report Transitions - run FK restrict ${randomUUID()}`);
  const run = await makeRun(client.id);
  const report = await makeReport(client.id, run.id);

  await assert.rejects(() => prisma.rankingRun.delete({ where: { id: run.id } }), /Foreign key constraint/);

  await prisma.rankingReport.delete({ where: { id: report.id } });
  await prisma.rankingRun.delete({ where: { id: run.id } });
  await prisma.client.delete({ where: { id: client.id } });
});

test.after(async () => {
  await prisma.$disconnect();
});
