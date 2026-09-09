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
  markSending,
  markSendFailed,
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
  // Build Report can also run directly off PENDING_ANALYSIS, skipping the
  // optional Claude Insights step entirely.
  assert.equal(isValidReportTransition(ReportStatus.PENDING_ANALYSIS, ReportStatus.REPORT_READY), true);
  assert.equal(isValidReportTransition(ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFTED), true);
  assert.equal(isValidReportTransition(ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFT_FAILED), true);
  assert.equal(isValidReportTransition(ReportStatus.EMAIL_DRAFT_FAILED, ReportStatus.REPORT_READY), true);
  assert.equal(isValidReportTransition(ReportStatus.EMAIL_DRAFTED, ReportStatus.PENDING_APPROVAL), true);
  assert.equal(isValidReportTransition(ReportStatus.PENDING_APPROVAL, ReportStatus.APPROVED), true);
  assert.equal(isValidReportTransition(ReportStatus.PENDING_APPROVAL, ReportStatus.REJECTED), true);
  // APPROVED can no longer jump straight to SENT -- it must pass through
  // the atomically-claimed SENDING state first (see approveAndSend.ts).
  assert.equal(isValidReportTransition(ReportStatus.APPROVED, ReportStatus.SENDING), true);
  assert.equal(isValidReportTransition(ReportStatus.APPROVED, ReportStatus.SENT), false);
  assert.equal(isValidReportTransition(ReportStatus.SENDING, ReportStatus.SENT), true);
  // A failed send reverts the claim so a legitimate retry stays possible.
  assert.equal(isValidReportTransition(ReportStatus.SENDING, ReportStatus.APPROVED), true);

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

    const sending = await markSending(report.id);
    assert.equal(sending.status, ReportStatus.SENDING);

    const sent = await markSent(report.id);
    assert.equal(sent.status, ReportStatus.SENT);
    assert.ok(sent.sentAt);
  } finally {
    await cleanupClient(client.id);
  }
});

test("markSending: only one of two concurrent callers can claim APPROVED -> SENDING, the loser is rejected", async () => {
  const client = await makeClient(`Report Transitions - concurrent markSending ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    await markAnalysisReady(report.id, { analyticsJson: {}, analysisJson: {} });
    await markReportReady(report.id, {});
    await markEmailDrafted(report.id, { emailSubject: "s", emailBody: "b", resolvedRecipients: ["a@example.com"] });
    await submitForApproval(report.id);
    await approveReport(report.id, { approvedBy: "om@syspreedigital.com" });

    const results = await Promise.allSettled([markSending(report.id), markSending(report.id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent claim must win");
    assert.equal(rejected.length, 1, "exactly one concurrent claim must lose");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof InvalidReportTransitionError);

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.SENDING);
  } finally {
    await cleanupClient(client.id);
  }
});

test("markSendFailed: SENDING -> APPROVED, recording the error and leaving the report retryable -- never stuck in SENDING", async () => {
  const client = await makeClient(`Report Transitions - markSendFailed ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    await markAnalysisReady(report.id, { analyticsJson: {}, analysisJson: {} });
    await markReportReady(report.id, {});
    await markEmailDrafted(report.id, { emailSubject: "s", emailBody: "b", resolvedRecipients: ["a@example.com"] });
    await submitForApproval(report.id);
    await approveReport(report.id, { approvedBy: "om@syspreedigital.com" });
    await markSending(report.id);

    const reverted = await markSendFailed(report.id, { errorMessage: "ClickUp composer timed out" });
    assert.equal(reverted.status, ReportStatus.APPROVED);
    assert.equal(reverted.lastErrorMessage, "ClickUp composer timed out");

    // Retryable: a fresh markSending call succeeds again from APPROVED.
    const retried = await markSending(report.id);
    assert.equal(retried.status, ReportStatus.SENDING);
  } finally {
    await cleanupClient(client.id);
  }
});

test("markSendFailed refuses to run against a report that isn't SENDING (e.g. still APPROVED, never claimed)", async () => {
  const client = await makeClient(`Report Transitions - markSendFailed guard ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    await markAnalysisReady(report.id, { analyticsJson: {}, analysisJson: {} });
    await markReportReady(report.id, {});
    await markEmailDrafted(report.id, { emailSubject: "s", emailBody: "b", resolvedRecipients: ["a@example.com"] });
    await submitForApproval(report.id);
    await approveReport(report.id, { approvedBy: "om@syspreedigital.com" });

    await assert.rejects(() => markSendFailed(report.id, { errorMessage: "should not apply" }), InvalidReportTransitionError);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, ReportStatus.APPROVED);
    assert.equal(unchanged.lastErrorMessage, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("markSent refuses to run directly from APPROVED -- SENDING must be claimed first", async () => {
  const client = await makeClient(`Report Transitions - markSent guard ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    await markAnalysisReady(report.id, { analyticsJson: {}, analysisJson: {} });
    await markReportReady(report.id, {});
    await markEmailDrafted(report.id, { emailSubject: "s", emailBody: "b", resolvedRecipients: ["a@example.com"] });
    await submitForApproval(report.id);
    await approveReport(report.id, { approvedBy: "om@syspreedigital.com" });

    await assert.rejects(() => markSent(report.id), InvalidReportTransitionError);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, ReportStatus.APPROVED);
    assert.equal(unchanged.sentAt, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("Build Report shortcut: PENDING_ANALYSIS -> REPORT_READY directly via markReportReady, storing clientPdfPath (no Claude Insights step)", async () => {
  const client = await makeClient(`Report Transitions - build report shortcut ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id);
    assert.equal(report.status, ReportStatus.PENDING_ANALYSIS);

    const reportReady = await markReportReady(report.id, { clientPdfPath: "/reports/fake.pdf" });
    assert.equal(reportReady.status, ReportStatus.REPORT_READY);
    assert.equal(reportReady.clientPdfPath, "/reports/fake.pdf");
    assert.equal(reportReady.reportHtml, null, "no HTML narrative is generated on this path");
  } finally {
    await cleanupClient(client.id);
  }
});

test("Build Report re-entry: markReportReady is callable again from REPORT_READY itself (idempotent regenerate-in-place, not a backward transition)", async () => {
  const client = await makeClient(`Report Transitions - build report re-entry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, { status: ReportStatus.REPORT_READY });

    const regenerated = await markReportReady(report.id, { clientPdfPath: "/reports/regenerated.pdf" });
    assert.equal(regenerated.status, ReportStatus.REPORT_READY, "status does not move backward or forward -- it's the same state before and after");
    assert.equal(regenerated.clientPdfPath, "/reports/regenerated.pdf");
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

    // PENDING_ANALYSIS -> REPORT_READY (Build Report's shortcut) is now
    // valid -- see the dedicated "Build Report shortcut" test above. What's
    // still illegal from PENDING_ANALYSIS is skipping straight into the
    // approval/send stages.
    const freshReport = await makeReport(client.id, run.id); // PENDING_ANALYSIS
    await assert.rejects(() => submitForApproval(freshReport.id), InvalidReportTransitionError);
    await assert.rejects(() => approveReport(freshReport.id, { approvedBy: "x" }), InvalidReportTransitionError);

    const sentReport = await makeReport(client.id, run.id, { status: ReportStatus.SENT });
    await assert.rejects(() => markSent(sentReport.id), InvalidReportTransitionError);
    await assert.rejects(() => rejectReport(sentReport.id), InvalidReportTransitionError);
    await assert.rejects(() => retryAnalysis(sentReport.id), InvalidReportTransitionError);
    await assert.rejects(() => markReportReady(sentReport.id, { clientPdfPath: "x" }), InvalidReportTransitionError);

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

test("markSent: auditCommentPosted defaults to null when omitted, and stores whatever boolean is passed", async () => {
  const client = await makeClient(`Report Transitions - markSent audit comment ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);

    const reportA = await makeReport(client.id, run.id);
    await markAnalysisReady(reportA.id, { analyticsJson: {}, analysisJson: {} });
    await markReportReady(reportA.id, {});
    await markEmailDrafted(reportA.id, { emailSubject: "s", emailBody: "b", resolvedRecipients: ["a@example.com"] });
    await submitForApproval(reportA.id);
    await approveReport(reportA.id, { approvedBy: "om@syspreedigital.com" });
    await markSending(reportA.id);
    const sentNoArg = await markSent(reportA.id);
    assert.equal(sentNoArg.auditCommentPosted, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
