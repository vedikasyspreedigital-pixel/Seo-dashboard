import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { ReportStatus } from "@prisma/client";
import { INTERRUPTED_MESSAGE, recoverInterruptedDeliveries } from "../backend/worker/recoverInterruptedDeliveries.js";
import { approveAndSendReport } from "../backend/reporting/approveAndSend.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";

// Audit 2026-10-27: a report email cut off by a restart stayed SENDING forever (no retry, no regenerate),
// and a Domain Intelligence post stayed "Posting to ClickUp" with no Retry button.

test("startup: an interrupted report send becomes retryable with a 'check ClickUp' reason; finished ones are untouched", async () => {
  const client = await prisma.client.create({ data: { name: `Interrupted Sends ${randomUUID()}`, domainReportTaskId: "86dinter1" } });
  try {
    const run = await prisma.rankingRun.create({
      data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "x", totalRows: 1, status: "COMPLETED", completedAt: new Date() },
    });
    const base = { clientId: client.id, runId: run.id, analyticsJson: {}, emailSubject: "Sep update", emailBody: "Hi", resolvedRecipients: ["ops@example.com"] };
    const cutOff = await prisma.rankingReport.create({ data: { ...base, status: ReportStatus.SENDING, approvedBy: "om@syspreedigital.com", approvedAt: new Date() } });
    const sent = await prisma.rankingReport.create({ data: { ...base, status: ReportStatus.SENT, sentAt: new Date() } });
    const domain = { clientId: client.id, websiteUrl: "x.test", sources: ["semrush"], reportMode: "combined", summary: {}, files: [] };
    const posting = await prisma.domainReport.create({ data: { ...domain, status: "POSTING" } });
    const posted = await prisma.domainReport.create({ data: { ...domain, status: "POSTED", postedAt: new Date() } });
    const building = await prisma.domainReport.create({ data: { ...domain, status: "GENERATING" } });

    assert.deepEqual(await recoverInterruptedDeliveries({ onlyClientId: client.id }), { reports: 1, domainReports: 1, domainBuilds: 1 });
    const buildingRow = await prisma.domainReport.findUniqueOrThrow({ where: { id: building.id } });
    assert.equal(buildingRow.status, "FAILED", "a build cut off by a restart no longer stays 'Generating' forever");
    assert.match(buildingRow.error ?? "", /run it again/);

    const cutOffRow = await prisma.rankingReport.findUniqueOrThrow({ where: { id: cutOff.id } });
    assert.equal(cutOffRow.status, ReportStatus.APPROVED, "retryable, not stuck in SENDING");
    assert.equal(cutOffRow.lastErrorMessage, INTERRUPTED_MESSAGE);
    assert.equal((await prisma.rankingReport.findUniqueOrThrow({ where: { id: sent.id } })).status, ReportStatus.SENT);
    const postingRow = await prisma.domainReport.findUniqueOrThrow({ where: { id: posting.id } });
    assert.equal(postingRow.status, "POST_FAILED", "shows the Retry button");
    assert.match(postingRow.error ?? "", /Check the ClickUp task before retrying/);
    assert.equal((await prisma.domainReport.findUniqueOrThrow({ where: { id: posted.id } })).status, "POSTED");

    // The retry goes through the normal approve-and-send path (approval isn't asked again).
    const retry = await approveAndSendReport(cutOff.id, { approvedBy: "om@syspreedigital.com", sendEmail: createMockEmailSender() });
    assert.equal(retry.outcome, "SENT");
  } finally {
    await prisma.reportSend.deleteMany({ where: { report: { clientId: client.id } } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baseline: { clientId: client.id } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.rankingReport.deleteMany({ where: { clientId: client.id } });
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
