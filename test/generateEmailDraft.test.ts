import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { generateEmailDraft } from "../backend/reporting/generateEmailDraft.js";
import { createMockClaudeEmailDrafter } from "../backend/reporting/mockClaudeClient.js";
import { retryEmailDraft } from "../backend/reporting/reportTransitions.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433), mocked Claude client. No real
// Claude calls, no email sent, no ranking worker/state-machine code touched.

const SAMPLE_ANALYTICS = {
  runId: "run-x",
  previousRunId: null,
  totals: { totalKeywords: 5, averageRank: 14.3, top3Count: 0, top10Count: 2, notIn100Count: 3 },
  movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] },
};

const SAMPLE_ANALYSIS = {
  overallNarrative: "A steady period.",
  keyInsights: ["2 keywords rank in the top 10."],
  notableWins: [],
  notableLosses: [],
  recommendedFocusAreas: [],
};

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "email-draft-test.xlsx",
      sourceFilePath: "local-test/email-draft-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
    },
  });
}

async function makeReportReadyReport(clientId: string, runId: string) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status: ReportStatus.REPORT_READY,
      analyticsJson: SAMPLE_ANALYTICS,
      analysisJson: SAMPLE_ANALYSIS,
      reportHtml: "<html>stub report</html>",
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.clientReportConfig.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("generateEmailDraft: success drives EMAIL_DRAFTED -> PENDING_APPROVAL, recipients + ClickUp task resolved from client config (not Claude)", async () => {
  const client = await makeClient(`Email Draft Test - success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"],
        clickupTaskUrl: "https://app.clickup.com/t/abc123",
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });
    const report = await makeReportReadyReport(client.id, run.id);

    const result = await generateEmailDraft(report.id, createMockClaudeEmailDrafter());
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome === "SUCCESS") {
      assert.deepEqual(result.recipients, ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"]);
    }

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL); // drove all the way through EMAIL_DRAFTED
    assert.ok(persisted.emailSubject && persisted.emailSubject.includes(client.name));
    assert.ok(persisted.emailBody);
    assert.ok(persisted.emailBodyHtml);
    assert.deepEqual(persisted.resolvedRecipients, ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"]);
    assert.equal(persisted.resolvedClickupTaskUrl, "https://app.clickup.com/t/abc123");
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: no active client config -> recipients resolve to an empty list, not an error", async () => {
  const client = await makeClient(`Email Draft Test - no config ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReportReadyReport(client.id, run.id);

    const result = await generateEmailDraft(report.id, createMockClaudeEmailDrafter());
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome === "SUCCESS") assert.deepEqual(result.recipients, []);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL);
    assert.deepEqual(persisted.resolvedRecipients, []);
    assert.equal(persisted.resolvedClickupTaskUrl, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: transport-style failure ends in EMAIL_DRAFT_FAILED, stays out of the approval queue", async () => {
  const client = await makeClient(`Email Draft Test - call error ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReportReadyReport(client.id, run.id);

    const throwingClient = async () => {
      throw new Error("Claude API unreachable");
    };
    const result = await generateEmailDraft(report.id, throwingClient);
    assert.equal(result.outcome, "CALL_ERROR");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.EMAIL_DRAFT_FAILED);
    assert.equal(persisted.lastErrorMessage, "Claude API unreachable");
    assert.equal(persisted.emailSubject, null);
    assert.equal(persisted.resolvedRecipients, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: schema-invalid output (attempted recipients field) ends in EMAIL_DRAFT_FAILED, not silently accepted", async () => {
  const client = await makeClient(`Email Draft Test - validation error ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReportReadyReport(client.id, run.id);

    const sneakyClient = async () => ({ subject: "Hi", bodyText: "Body", recipients: ["hacked@example.com"] });
    const result = await generateEmailDraft(report.id, sneakyClient);
    assert.equal(result.outcome, "VALIDATION_ERROR");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.EMAIL_DRAFT_FAILED);
    assert.ok(persisted.lastErrorMessage?.includes("recipients"));
    assert.equal(persisted.resolvedRecipients, null); // never persisted, even transiently
  } finally {
    await cleanupClient(client.id);
  }
});

test("retry path: EMAIL_DRAFT_FAILED -> retryEmailDraft -> REPORT_READY -> generateEmailDraft succeeds -> PENDING_APPROVAL", async () => {
  const client = await makeClient(`Email Draft Test - retry ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "casual",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["ops@example.com"],
        reportingFrequency: "monthly",
        templateId: "standard-v1",
      },
    });
    const report = await makeReportReadyReport(client.id, run.id);

    const failingResult = await generateEmailDraft(report.id, async () => {
      throw new Error("temporary model timeout");
    });
    assert.equal(failingResult.outcome, "CALL_ERROR");

    const afterFailure = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(afterFailure.status, ReportStatus.EMAIL_DRAFT_FAILED);

    const retried = await retryEmailDraft(report.id);
    assert.equal(retried.status, ReportStatus.REPORT_READY);
    assert.equal(retried.lastErrorMessage, null);

    const succeeded = await generateEmailDraft(report.id, createMockClaudeEmailDrafter());
    assert.equal(succeeded.outcome, "SUCCESS");

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.PENDING_APPROVAL);
    assert.deepEqual(final.resolvedRecipients, ["ops@example.com"]);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
