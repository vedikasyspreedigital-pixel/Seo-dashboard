import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { approveAndSendReport } from "../backend/reporting/approveAndSend.js";
import { updateReportDraft } from "../backend/reporting/editReportDraft.js";
import { createMockEmailSender, createFailingMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433), mocked email sender. No real
// email is ever sent, no ranking worker/state-machine code touched.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "approve-send-test.xlsx",
      sourceFilePath: "local-test/approve-send-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
    },
  });
}

async function makePendingApprovalReport(clientId: string, runId: string, recipients: string[] = ["ops@example.com"]) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.PENDING_APPROVAL,
      analyticsJson: { totals: { totalKeywords: 1 } },
      analysisJson: { overallNarrative: "ok", keyInsights: [], notableWins: [], notableLosses: [], recommendedFocusAreas: [] },
      reportHtml: "<html>report</html>",
      emailSubject: "Your ranking update",
      emailBody: "Here is your update.",
      emailBodyHtml: "<p>Here is your update.</p>",
      resolvedRecipients: recipients,
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

test("approval: PENDING_APPROVAL -> SENT, sender receives exactly the resolved recipients/subject/body", async () => {
  const client = await makeClient(`Approve Send Test - success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, ["ops@example.com", "owner@example.com"]);

    const sentCalls: unknown[] = [];
    const sendEmail = createMockEmailSender((params) => sentCalls.push(params));

    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail });
    assert.equal(result.outcome, "SENT");

    assert.equal(sentCalls.length, 1);
    assert.deepEqual(sentCalls[0], {
      to: ["ops@example.com", "owner@example.com"],
      subject: "Your ranking update",
      bodyText: "Here is your update.",
      bodyHtml: "<p>Here is your update.</p>",
      clickupTaskUrl: undefined,
      attachmentHtml: "<html>report</html>",
      attachmentFilename: `seo-report-${report.id}.html`,
      excelPdfBuffer: undefined,
      excelPdfFilename: undefined,
    });

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.SENT);
    assert.equal(persisted.approvedBy, "om@syspreedigital.com");
    assert.ok(persisted.approvedAt);
    assert.ok(persisted.sentAt);
  } finally {
    await cleanupClient(client.id);
  }
});

// FIX #4, section 5/6/10: the entire point of persisting Save Changes edits
// is that the eventual send uses them -- never a fallback to whatever the
// report originally had. This traces the exact flow: Save Changes (PATCH /
// updateReportDraft) -> approve-and-send -> the values sendEmail actually
// receives, proving the EDITED values win, not the original ones.
test("Save Changes -> Approve & Send: the send uses the edited To/Subject/Body, never the report's original values", async () => {
  const client = await makeClient(`Approve Send Test - uses edited values ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, ["old@example.com"]);
    // Sanity: confirm the "before" state so the assertion below is a real
    // change, not a no-op.
    assert.deepEqual(report.resolvedRecipients, ["old@example.com"]);
    assert.equal(report.emailSubject, "Your ranking update");

    // The user opens Email Draft, edits every field, and clicks Save
    // Changes -- this is exactly what EmailDraftPage.tsx's handleSave calls
    // via PATCH /api/reports/:id.
    await updateReportDraft(report.id, {
      emailSubject: "EDITED subject after Save Changes",
      emailBody: "EDITED body after Save Changes",
      resolvedRecipients: ["new@example.com"],
    });

    const sentCalls: unknown[] = [];
    const sendEmail = createMockEmailSender((params) => sentCalls.push(params));
    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail });
    assert.equal(result.outcome, "SENT");

    assert.equal(sentCalls.length, 1);
    const sent = sentCalls[0] as { to: string[]; subject: string; bodyText: string };
    assert.deepEqual(sent.to, ["new@example.com"], "must use the edited recipient, not old@example.com");
    assert.equal(sent.subject, "EDITED subject after Save Changes");
    assert.equal(sent.bodyText, "EDITED body after Save Changes");
  } finally {
    await cleanupClient(client.id);
  }
});

test("approval: when generateExcelAttachment is injected, it's resolved for the REPORT (not the run) and passed through to sendEmail", async () => {
  const client = await makeClient(`Approve Send Test - excel attachment ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, ["ops@example.com"]);

    const sentCalls: unknown[] = [];
    const sendEmail = createMockEmailSender((params) => sentCalls.push(params));
    const excelCalls: string[] = [];
    const generateExcelAttachment = async (reportId: string) => {
      excelCalls.push(reportId);
      return { buffer: Buffer.from("fake-pdf-bytes"), filename: "ranking-export.pdf" };
    };

    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail, generateExcelAttachment });
    assert.equal(result.outcome, "SENT");

    // Resolved by reportId, not runId -- the real implementation needs the
    // report's analyticsJson/client/previousRun, none of which are
    // reachable from a bare runId.
    assert.deepEqual(excelCalls, [report.id]);
    assert.equal(sentCalls.length, 1);
    const sent = sentCalls[0] as { excelPdfBuffer?: Buffer; excelPdfFilename?: string };
    assert.equal(sent.excelPdfFilename, "ranking-export.pdf");
    assert.equal(sent.excelPdfBuffer?.toString(), "fake-pdf-bytes");
  } finally {
    await cleanupClient(client.id);
  }
});

test("no recipients: send is refused before approving, report stays PENDING_APPROVAL untouched", async () => {
  const client = await makeClient(`Approve Send Test - no recipients ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id, []);

    const sentCalls: unknown[] = [];
    const sendEmail = createMockEmailSender((params) => sentCalls.push(params));

    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail });
    assert.equal(result.outcome, "NO_RECIPIENTS");
    assert.equal(sentCalls.length, 0);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL); // never approved, nothing sent
    assert.equal(persisted.approvedBy, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("rejection: PENDING_APPROVAL -> REJECTED, and a rejected report can never be sent afterward", async () => {
  const client = await makeClient(`Approve Send Test - rejection ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const { rejectReport } = await import("../backend/reporting/reportTransitions.js");
    const rejected = await rejectReport(report.id);
    assert.equal(rejected.status, ReportStatus.REJECTED);

    const sendEmail = createMockEmailSender();
    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail });
    assert.equal(result.outcome, "ALREADY_PROCESSED");
  } finally {
    await cleanupClient(client.id);
  }
});

test("duplicate-send protection: calling approve-and-send twice sequentially only sends once", async () => {
  const client = await makeClient(`Approve Send Test - sequential duplicate ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    let sendCount = 0;
    const sendEmail = createMockEmailSender(() => {
      sendCount += 1;
    });

    const first = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail });
    assert.equal(first.outcome, "SENT");

    const second = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail });
    assert.equal(second.outcome, "ALREADY_PROCESSED");

    assert.equal(sendCount, 1);
  } finally {
    await cleanupClient(client.id);
  }
});

test("duplicate-send protection: two concurrent approve-and-send calls on the same report send exactly once", async () => {
  const client = await makeClient(`Approve Send Test - concurrent duplicate ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    let sendCount = 0;
    const sendEmail = createMockEmailSender(() => {
      sendCount += 1;
    });

    const results = await Promise.allSettled([
      approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail }),
      approveAndSendReport(report.id, { approvedBy: "b@example.com", sendEmail }),
    ]);

    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.outcome : "REJECTED_PROMISE"));
    assert.equal(outcomes.filter((o) => o === "SENT").length, 1);
    assert.equal(outcomes.filter((o) => o === "ALREADY_PROCESSED").length, 1);
    assert.equal(sendCount, 1); // the email provider was invoked exactly once, not twice

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.SENT);
  } finally {
    await cleanupClient(client.id);
  }
});

test("failure handling: a send failure leaves the report APPROVED (not lost), and a retry with a working sender succeeds", async () => {
  const client = await makeClient(`Approve Send Test - send failure retry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const failing = createFailingMockEmailSender("SMTP timeout");
    const failed = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: failing });
    assert.equal(failed.outcome, "SEND_FAILED");
    if (failed.outcome === "SEND_FAILED") assert.equal(failed.errorMessage, "SMTP timeout");

    const afterFailure = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(afterFailure.status, ReportStatus.APPROVED); // approval survived; only the send failed
    assert.equal(afterFailure.approvedBy, "a@example.com");

    let sendCount = 0;
    const working = createMockEmailSender(() => {
      sendCount += 1;
    });
    const retried = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: working });
    assert.equal(retried.outcome, "SENT");
    assert.equal(sendCount, 1);

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.SENT);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
