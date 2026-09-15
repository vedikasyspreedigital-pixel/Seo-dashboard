import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { approveAndSendReport } from "../backend/reporting/approveAndSend.js";
import { updateReportDraft } from "../backend/reporting/editReportDraft.js";
import { generateEmailDraft } from "../backend/reporting/generateEmailDraft.js";
import { createMockEmailSender, createFailingMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433), mocked email sender. No real
// email is ever sent, no ranking worker/state-machine code touched.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeClientInWorkspace(name: string, workspaceId: string) {
  return prisma.client.create({ data: { name, workspaceId } });
}

async function makeRun(clientId: string, completedAt?: Date) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "approve-send-test.xlsx",
      sourceFilePath: "local-test/approve-send-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
      completedAt,
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
      cc: undefined,
      subject: "Your ranking update",
      bodyText: "Here is your update.",
      bodyHtml: "<p>Here is your update.</p>",
      clickupTaskUrl: undefined,
      workspaceSlug: null,
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

// Stronger regression than the test above: that one starts from a
// hand-built PENDING_APPROVAL fixture whose emailSubject/emailBody are
// already arbitrary test strings, not the real template output. This one
// drives the ACTUAL generateEmailDraft() step first (the same
// buildDefaultEmailDraft template EmailDraftPage shows the user), captures
// what it produced, then edits Subject/Body to something deliberately
// different and traces the full path: generate -> Save Changes
// (updateReportDraft) -> Approve & Send (approveAndSendReport) -> the
// sender. Proves the edited values (not the generated ones) are what
// ultimately reaches sendEmail() AND what's left persisted afterward --
// nothing in between silently regenerates or reverts them.
test("generated draft -> Save Changes edits Subject/Body -> Approve & Send: sender and persisted row get the edited values, never the originally generated draft", async () => {
  const client = await makeClient(`Approve Send Test - edited vs generated ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, new Date("2026-09-01T00:00:00Z"));
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["ops@example.com"],
        reportingFrequency: "manual",
        templateId: "standard-v1",
      },
    });
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        status: ReportStatus.REPORT_READY,
        analyticsJson: { totals: { totalKeywords: 1 } },
        clientPdfPath: "/tmp/stub-report.pdf",
      },
    });

    // Step 1: the REAL draft-generation pipeline -- the same deterministic
    // template EmailDraftPage first shows the user, not a hand-picked
    // fixture string.
    const generated = await generateEmailDraft(report.id);
    assert.equal(generated.outcome, "SUCCESS");
    const generatedSubject = generated.subject;
    const generatedBody = generated.bodyText;

    // Step 2: the user edits Subject/Body in EmailDraftEditor and clicks
    // Save Changes -- exactly what PATCH /api/reports/:id -> updateReportDraft
    // performs.
    const editedSubject = "Manually rewritten subject -- does not match the template";
    const editedBody = "Manually rewritten body -- completely different wording from the generated draft.";
    await updateReportDraft(report.id, { emailSubject: editedSubject, emailBody: editedBody });

    // Sanity: prove the edit is a REAL change from what was generated --
    // otherwise every assertion below could pass "by accident" even if the
    // send path silently fell back to the generated draft.
    assert.notEqual(editedSubject, generatedSubject);
    assert.notEqual(editedBody, generatedBody);

    // Step 3: Approve & Send.
    const sentCalls: { subject: string; bodyText: string }[] = [];
    const sendEmail = createMockEmailSender((params) => sentCalls.push(params as { subject: string; bodyText: string }));
    const result = await approveAndSendReport(report.id, { approvedBy: "om@syspreedigital.com", sendEmail });
    assert.equal(result.outcome, "SENT");

    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].subject, editedSubject, "sender must receive the EDITED subject");
    assert.equal(sentCalls[0].bodyText, editedBody, "sender must receive the EDITED body");
    assert.notEqual(sentCalls[0].subject, generatedSubject, "sender must NOT receive the originally generated subject");
    assert.notEqual(sentCalls[0].bodyText, generatedBody, "sender must NOT receive the originally generated body");

    // Step 4: nothing between Save Changes and the send silently
    // regenerated or reverted Subject/Body -- the persisted row still holds
    // exactly what was edited.
    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.emailSubject, editedSubject);
    assert.equal(persisted.emailBody, editedBody);
    assert.equal(persisted.status, ReportStatus.SENT);
  } finally {
    await prisma.clientReportConfig.deleteMany({ where: { clientId: client.id } });
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

// Stronger version of the test above: an instant mock resolves so fast
// there's barely any await-yield window for a real interleaving, so it
// could theoretically pass "by luck" even without the atomic SENDING claim.
// This one holds sendEmail open for 100ms so BOTH concurrent calls are
// guaranteed to have already reached (or be waiting to reach) the send step
// before either finishes -- proving the guard holds under a realistic race
// window, not just a lucky one.
test("duplicate-send protection: two concurrent approve-and-send calls with a SLOW sender still send exactly once, and the loser never even calls the sender", async () => {
  const client = await makeClient(`Approve Send Test - concurrent slow duplicate ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    let sendCount = 0;
    const sendEmail = async () => {
      sendCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { messageId: `mock-${randomUUID()}` };
    };

    const results = await Promise.allSettled([
      approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail }),
      approveAndSendReport(report.id, { approvedBy: "b@example.com", sendEmail }),
    ]);

    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.outcome : "REJECTED_PROMISE"));
    assert.equal(outcomes.filter((o) => o === "SENT").length, 1);
    assert.equal(outcomes.filter((o) => o === "ALREADY_PROCESSED").length, 1);
    // The critical guarantee: sendEmail (the real ClickUp automation, here
    // mocked) was invoked exactly once -- the loser was rejected by the
    // atomic APPROVED -> SENDING claim BEFORE it could ever call sendEmail,
    // not merely prevented from double-counting after the fact.
    assert.equal(sendCount, 1);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.SENT);
  } finally {
    await cleanupClient(client.id);
  }
});

test("SENDING never gets stuck: a send failure while claimed reverts to APPROVED, never leaving the report unrecoverable", async () => {
  const client = await makeClient(`Approve Send Test - never stuck in SENDING ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const failing = createFailingMockEmailSender("ClickUp composer timed out");
    const failed = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: failing });
    assert.equal(failed.outcome, "SEND_FAILED");

    const afterFailure = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(afterFailure.status, ReportStatus.APPROVED, "must revert out of SENDING, not get stuck there");
    assert.equal(afterFailure.lastErrorMessage, "ClickUp composer timed out");

    // Two concurrent retries after the failure -- same guarantee holds:
    // exactly one wins the re-claim, the other is rejected before sending.
    let sendCount = 0;
    const working = createMockEmailSender(() => {
      sendCount += 1;
    });
    const retries = await Promise.allSettled([
      approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: working }),
      approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: working }),
    ]);
    const retryOutcomes = retries.map((r) => (r.status === "fulfilled" ? r.value.outcome : "REJECTED_PROMISE"));
    assert.equal(retryOutcomes.filter((o) => o === "SENT").length, 1);
    assert.equal(sendCount, 1);

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.SENT);
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

// Phase 5: audit-comment outcome is purely observability, persisted for
// later inspection -- it must NEVER change whether the send itself counts
// as SENT, and must never trigger a duplicate resend.
test("audit-comment observability: a sender reporting auditCommentPosted:false still counts as a full SENT success, and the flag is persisted", async () => {
  const client = await makeClient(`Approve Send Test - audit comment failed ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const sendEmail = async () => ({ messageId: `mock-${randomUUID()}`, auditCommentPosted: false });
    const result = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail });
    assert.equal(result.outcome, "SENT", "a failed audit comment must never turn a real send into a failure");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.SENT);
    assert.equal(persisted.auditCommentPosted, false);

    // And critically: no automatic/implicit resend happens as a result --
    // the report is terminal (SENT), a subsequent approve-and-send call is
    // rejected exactly like any other already-sent report.
    const again = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail });
    assert.equal(again.outcome, "ALREADY_PROCESSED");
  } finally {
    await cleanupClient(client.id);
  }
});

test("audit-comment observability: auditCommentPosted:true is persisted when the sender reports success", async () => {
  const client = await makeClient(`Approve Send Test - audit comment succeeded ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const sendEmail = async () => ({ messageId: `mock-${randomUUID()}`, auditCommentPosted: true });
    const result = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail });
    assert.equal(result.outcome, "SENT");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.auditCommentPosted, true);
  } finally {
    await cleanupClient(client.id);
  }
});

test("audit-comment observability: a sender that doesn't model an audit-comment step at all (e.g. the mock) persists null, not false", async () => {
  const client = await makeClient(`Approve Send Test - audit comment not applicable ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const result = await approveAndSendReport(report.id, { approvedBy: "a@example.com", sendEmail: createMockEmailSender() });
    assert.equal(result.outcome, "SENT");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.auditCommentPosted, null, "undefined from the sender must be stored as null, not misrepresented as false");
  } finally {
    await cleanupClient(client.id);
  }
});

// Regression coverage for the gap raised directly after shipping the
// Save-Changes-only version of this guard: a report that's never had Save
// Changes clicked on it (approved straight from a freshly generated draft)
// would otherwise skip the duplicate-date check entirely and reach a real
// send. This proves the send-time gate in approveAndSendReport itself
// catches it, independent of updateReportDraft.
test("approval is refused when another SENT report for the same client already covers the same date range, even without ever calling Save Changes", async () => {
  const client = await makeClient(`Approve Send Test - duplicate date ${randomUUID()}`);
  try {
    const sameDay = new Date("2026-09-15T09:00:00.000Z");
    const sentRun = await makeRun(client.id, sameDay);
    const sentReport = await makePendingApprovalReport(client.id, sentRun.id);
    await prisma.rankingReport.update({ where: { id: sentReport.id }, data: { status: ReportStatus.SENT, sentAt: new Date() } });

    const laterSameDayRun = await makeRun(client.id, new Date("2026-09-15T15:30:00.000Z"));
    const draftReport = await makePendingApprovalReport(client.id, laterSameDayRun.id);

    const sentCalls: unknown[] = [];
    const result = await approveAndSendReport(draftReport.id, {
      approvedBy: "a@example.com",
      sendEmail: createMockEmailSender((params) => sentCalls.push(params)),
    });

    assert.equal(result.outcome, "DUPLICATE_DATE");
    if (result.outcome === "DUPLICATE_DATE") assert.equal(result.conflictingReportId, sentReport.id);
    assert.equal(sentCalls.length, 0, "the sender must never be invoked once a duplicate is detected");

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: draftReport.id } });
    assert.equal(unchanged.status, ReportStatus.PENDING_APPROVAL, "a refused approval must never transition the report");
  } finally {
    await cleanupClient(client.id);
  }
});

// Per-workspace ClickUp session coverage: approveAndSendReport is the one
// place that resolves Report -> Client -> Workspace and must pass the
// result to sendEmail as workspaceSlug (see clickupSessionResolution.test.ts
// for the pure path-selection logic this feeds into). Never client-supplied
// -- always derived server-side from the report's own client.
test("approval passes the report client's workspace slug through to sendEmail", async () => {
  const workspace = await prisma.workspace.create({ data: { slug: `approve-send-workspace-${randomUUID()}`, name: "Approve Send Test Workspace" } });
  const client = await makeClientInWorkspace(`Approve Send Test - workspace slug ${randomUUID()}`, workspace.id);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const sentCalls: { workspaceSlug?: string | null }[] = [];
    const result = await approveAndSendReport(report.id, {
      approvedBy: "a@example.com",
      sendEmail: createMockEmailSender((params) => sentCalls.push(params)),
    });

    assert.equal(result.outcome, "SENT");
    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].workspaceSlug, workspace.slug);
  } finally {
    await cleanupClient(client.id);
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }
});

test("approval passes workspaceSlug: null through to sendEmail for a client with no workspace assigned", async () => {
  const client = await makeClient(`Approve Send Test - no workspace ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const sentCalls: { workspaceSlug?: string | null }[] = [];
    const result = await approveAndSendReport(report.id, {
      approvedBy: "a@example.com",
      sendEmail: createMockEmailSender((params) => sentCalls.push(params)),
    });

    assert.equal(result.outcome, "SENT");
    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].workspaceSlug, null);
  } finally {
    await cleanupClient(client.id);
  }
});

// Regression coverage for the sender-identity requirement: the ClickUp
// email's sender/display name must come from whichever ClickUp
// account/session actually sends it (resolved purely by workspaceSlug),
// and must NEVER be derivable from the SERP Console user who clicked
// Approve & Send. approvedBy is persisted on the report row (for the
// audit trail) but must never reach sendEmail() -- this proves it,
// using an approvedBy value distinctive enough that it couldn't
// accidentally match anything legitimately present in the params (like
// a recipient address or workspace slug).
test("approvedBy (the SERP Console user) never reaches sendEmail() in any form -- sender identity is not something this app sets", async () => {
  const approvingUser = `should-never-appear-in-sendemail-params-${randomUUID()}@example.com`;
  const client = await makeClient(`Approve Send Test - sender identity ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const sentCalls: Record<string, unknown>[] = [];
    const result = await approveAndSendReport(report.id, {
      approvedBy: approvingUser,
      sendEmail: createMockEmailSender((params) => sentCalls.push(params as unknown as Record<string, unknown>)),
    });

    assert.equal(result.outcome, "SENT");
    assert.equal(sentCalls.length, 1);

    const sentJson = JSON.stringify(sentCalls[0]);
    assert.ok(!sentJson.includes(approvingUser), "the approving SERP Console user's email must not appear anywhere in what's handed to sendEmail()");

    // Explicit allowlist: these are the ONLY fields sendEmail() may ever
    // receive. Any new field added here in the future must be deliberately
    // reviewed for whether it could leak SERP-Console-user identity into
    // the ClickUp send -- this test fails loudly (not silently) if one is
    // added without updating this list.
    const allowedKeys = ["to", "cc", "subject", "bodyText", "bodyHtml", "clickupTaskUrl", "workspaceSlug", "attachmentHtml", "attachmentFilename", "excelPdfBuffer", "excelPdfFilename"];
    for (const key of Object.keys(sentCalls[0])) {
      assert.ok(allowedKeys.includes(key), `sendEmail() received an unexpected field "${key}" -- review whether it could carry SERP-Console-user identity`);
    }

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.approvedBy, approvingUser, "approvedBy IS correctly persisted on the report itself -- just never passed to sendEmail()");
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
