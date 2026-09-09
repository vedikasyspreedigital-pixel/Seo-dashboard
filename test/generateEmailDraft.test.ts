import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { generateEmailDraft, resolveClickupTaskUrl } from "../backend/reporting/generateEmailDraft.js";
import { retryEmailDraft } from "../backend/reporting/reportTransitions.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433). No AI call anywhere -- the
// draft is a deterministic template fill, so there is no CALL_ERROR/
// VALIDATION_ERROR path left to test; generateEmailDraft always succeeds
// once the report is REPORT_READY.

const SAMPLE_ANALYTICS = {
  runId: "run-x",
  previousRunId: null,
  totals: { totalKeywords: 5, averageRank: 14.3, top3Count: 0, top10Count: 2, notIn100Count: 3 },
  movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] },
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
      completedAt: new Date("2026-09-01T00:00:00Z"),
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
      clientPdfPath: "/tmp/stub-report.pdf",
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

test("generateEmailDraft: success drives REPORT_READY -> PENDING_APPROVAL, recipients + cc + ClickUp task resolved from client config", async () => {
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
        cc: ["manager@cashforcarsperth.com.au"],
        clickupTaskUrl: "https://app.clickup.com/t/abc123",
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });
    const report = await makeReportReadyReport(client.id, run.id);

    const result = await generateEmailDraft(report.id);
    assert.equal(result.outcome, "SUCCESS");
    assert.deepEqual(result.recipients, ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"]);
    assert.deepEqual(result.cc, ["manager@cashforcarsperth.com.au"]);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL);
    assert.ok(persisted.emailSubject?.startsWith("SEO Ranking Report"));
    assert.ok(persisted.emailBody?.startsWith("Dear Client,"));
    assert.deepEqual(persisted.resolvedRecipients, ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"]);
    assert.deepEqual(persisted.resolvedCc, ["manager@cashforcarsperth.com.au"]);
    assert.equal(persisted.resolvedClickupTaskUrl, "https://app.clickup.com/t/abc123");
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: no active client config -> recipients and cc both resolve to an empty list, not an error", async () => {
  const client = await makeClient(`Email Draft Test - no config ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReportReadyReport(client.id, run.id);

    const result = await generateEmailDraft(report.id);
    assert.equal(result.outcome, "SUCCESS");
    assert.deepEqual(result.recipients, []);
    assert.deepEqual(result.cc, []);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.PENDING_APPROVAL);
    assert.deepEqual(persisted.resolvedRecipients, []);
    assert.deepEqual(persisted.resolvedCc, []);
    assert.equal(persisted.resolvedClickupTaskUrl, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: client config with recipients but no cc -> cc resolves to an empty list", async () => {
  const client = await makeClient(`Email Draft Test - no cc ${randomUUID()}`);
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

    const result = await generateEmailDraft(report.id);
    assert.equal(result.outcome, "SUCCESS");
    assert.deepEqual(result.cc, []);

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.deepEqual(persisted.resolvedCc, []);
  } finally {
    await cleanupClient(client.id);
  }
});

// Workspace layer: ClickUp Task ID is the primary way to point a client at
// their delivery task; the pure resolver is tested directly, and the
// end-to-end test below confirms it actually flows through
// generateEmailDraft into resolvedClickupTaskUrl, not just in isolation.
test("resolveClickupTaskUrl: task id wins when set, building the URL as https://app.clickup.com/t/{id}", () => {
  assert.equal(resolveClickupTaskUrl({ clickupTaskId: "86d45e14k", clickupTaskUrl: "https://app.clickup.com/t/old" }), "https://app.clickup.com/t/86d45e14k");
});

test("resolveClickupTaskUrl: falls back to the raw task URL when no task id is set", () => {
  assert.equal(resolveClickupTaskUrl({ clickupTaskId: null, clickupTaskUrl: "https://app.clickup.com/t/abc123" }), "https://app.clickup.com/t/abc123");
  assert.equal(resolveClickupTaskUrl({ clickupTaskUrl: "https://app.clickup.com/t/abc123" }), "https://app.clickup.com/t/abc123");
});

test("resolveClickupTaskUrl: null when neither is set, or config itself is missing", () => {
  assert.equal(resolveClickupTaskUrl({ clickupTaskId: null, clickupTaskUrl: null }), null);
  assert.equal(resolveClickupTaskUrl(null), null);
  assert.equal(resolveClickupTaskUrl(undefined), null);
});

test("generateEmailDraft: clickupTaskId on the client config takes priority over clickupTaskUrl end-to-end", async () => {
  const client = await makeClient(`Email Draft Test - clickup task id priority ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["ops@example.com"],
        clickupTaskId: "86d45e14k",
        clickupTaskUrl: "https://app.clickup.com/t/stale-fallback-url",
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });
    const report = await makeReportReadyReport(client.id, run.id);

    const result = await generateEmailDraft(report.id);
    assert.equal(result.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.resolvedClickupTaskUrl, "https://app.clickup.com/t/86d45e14k", "task id must win over the stale fallback URL");
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateEmailDraft: only callable once the report is REPORT_READY -- rejects any other status", async () => {
  const client = await makeClient(`Email Draft Test - invalid transition ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await prisma.rankingReport.create({
      data: { clientId: client.id, runId: run.id, status: ReportStatus.PENDING_ANALYSIS, analyticsJson: SAMPLE_ANALYTICS },
    });

    await assert.rejects(() => generateEmailDraft(report.id));
  } finally {
    await cleanupClient(client.id);
  }
});

test("retryEmailDraft: EMAIL_DRAFT_FAILED -> REPORT_READY still works as a state transition (retained even though the deterministic draft itself cannot fail)", async () => {
  const client = await makeClient(`Email Draft Test - retry transition ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await prisma.rankingReport.create({
      data: { clientId: client.id, runId: run.id, status: ReportStatus.EMAIL_DRAFT_FAILED, analyticsJson: SAMPLE_ANALYTICS, lastErrorMessage: "stale failure from a previous version" },
    });

    const retried = await retryEmailDraft(report.id);
    assert.equal(retried.status, ReportStatus.REPORT_READY);
    assert.equal(retried.lastErrorMessage, null);

    const succeeded = await generateEmailDraft(report.id);
    assert.equal(succeeded.outcome, "SUCCESS");
    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.PENDING_APPROVAL);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
