import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { regenerateEmailDraft } from "../backend/reporting/generateEmailDraft.js";
import { InvalidReportTransitionError } from "../backend/reporting/errors.js";
import { ReportStatus } from "@prisma/client";

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: { clientId, sourceFilename: "regenerate-test.xlsx", sourceFilePath: "local-test/regenerate-test.xlsx", totalRows: 1, status: "COMPLETED" },
  });
}

async function makePendingApprovalReport(clientId: string, runId: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.PENDING_APPROVAL,
      analyticsJson: { totals: { totalKeywords: 3, averageRank: 10, top3Count: 0, top10Count: 1, notIn100Count: 1 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
      clientPdfPath: "/tmp/stub-report.pdf",
      emailSubject: "Stale subject",
      emailBody: "Stale body",
      resolvedRecipients: ["ops@example.com"],
      resolvedCc: ["stale-cc@example.com"],
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.clientReportConfig.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("regenerate: clears the stale draft (including cc), produces a fresh one from current client config, and ends back at PENDING_APPROVAL", async () => {
  const client = await makeClient(`Regenerate Test - success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["ops@example.com", "new-recipient@example.com"],
        cc: ["fresh-cc@example.com"],
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });
    const report = await makePendingApprovalReport(client.id, run.id);

    const result = await regenerateEmailDraft(report.id);
    assert.equal(result.outcome, "SUCCESS");
    assert.deepEqual(result.cc, ["fresh-cc@example.com"]);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL); // back in the approval queue
    assert.notEqual(persisted.emailSubject, "Stale subject"); // genuinely regenerated, not the old draft
    assert.notEqual(persisted.emailBody, "Stale body");
    assert.deepEqual(persisted.resolvedCc, ["fresh-cc@example.com"], "stale cc must be replaced, not merged with the new one");
  } finally {
    await cleanupClient(client.id);
  }
});

test("regenerate: refused when the report is not PENDING_APPROVAL", async () => {
  const client = await makeClient(`Regenerate Test - refused ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await prisma.rankingReport.create({ data: { clientId: client.id, runId: run.id, status: ReportStatus.SENT } });

    await assert.rejects(() => regenerateEmailDraft(report.id), InvalidReportTransitionError);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
