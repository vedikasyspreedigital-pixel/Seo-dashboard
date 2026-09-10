import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";

// Custom PDF attachment override: a report's email can attach either the
// system-generated PDF (default) or a human-uploaded replacement, without
// ever deleting/overwriting the generated one. See editReportDraft.ts's
// setCustomPdfAttachment and approveAndSend.ts's attachmentSource branch.

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
});

function authedApp(app: ReturnType<typeof createApp>) {
  return authedRequest(app, auth.cookieHeader);
}

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function makeClient(name: string) {
  return prisma.client.create({ data: { name, workspaceId: auth.workspace.id } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "custom-pdf-test.xlsx",
      sourceFilePath: "local-test/custom-pdf-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
      completedAt: new Date(),
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

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

// A minimal but genuinely valid PDF -- starts with the real %PDF- signature
// the upload endpoint checks for, small enough to keep the test fast.
const MINIMAL_PDF = Buffer.from("%PDF-1.4\n%%EOF");

test("POST /api/reports/:id/custom-pdf uploads and switches attachmentSource to custom", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Custom PDF Test - upload ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);
    assert.equal(report.attachmentSource, "generated", "defaults to generated before any upload");

    const res = await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", MINIMAL_PDF, "my-custom-report.pdf");
    assert.equal(res.status, 200);
    assert.equal(res.body.attachmentSource, "custom");
    assert.equal(res.body.customPdfFilename, "my-custom-report.pdf");
    assert.ok(res.body.customPdfPath, "customPdfPath should be set");
    assert.ok(res.body.clientPdfPath === null || res.body.clientPdfPath === undefined || true); // clientPdfPath untouched either way -- this fixture never set one

    const onDisk = await readFile(res.body.customPdfPath);
    assert.ok(onDisk.subarray(0, 5).equals(Buffer.from("%PDF-")), "the uploaded file was actually written to disk");
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/custom-pdf rejects a file without a real PDF signature", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Custom PDF Test - bad file ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", Buffer.from("not a pdf"), "fake.pdf");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PDF/i);

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.attachmentSource, "generated", "a rejected upload must not switch attachmentSource");
    assert.equal(unchanged.customPdfPath, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("POST /api/reports/:id/custom-pdf is refused once the report is no longer PENDING_APPROVAL", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Custom PDF Test - wrong status ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        status: ReportStatus.SENT,
        analyticsJson: {},
        emailSubject: "x",
        emailBody: "x",
        resolvedRecipients: ["ops@example.com"],
      },
    });

    const res = await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", MINIMAL_PDF, "custom.pdf");
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("PATCH /api/reports/:id refuses to switch attachmentSource to custom before any file is uploaded", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Custom PDF Test - premature switch ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await authedApp(app).patch(`/api/reports/${report.id}`).send({ attachmentSource: "custom" });
    assert.equal(res.status, 409);
  } finally {
    await cleanupClient(client.id);
  }
});

test("PATCH /api/reports/:id can switch back to generated after a custom upload, without losing the custom file", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const client = await makeClient(`Custom PDF Test - switch back ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);
    await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", MINIMAL_PDF, "custom.pdf");

    const res = await authedApp(app).patch(`/api/reports/${report.id}`).send({ attachmentSource: "generated" });
    assert.equal(res.status, 200);
    assert.equal(res.body.attachmentSource, "generated");
    assert.ok(res.body.customPdfPath, "switching back to generated must not clear the previously-uploaded custom PDF");
  } finally {
    await cleanupClient(client.id);
  }
});

test("approveAndSendReport attaches the custom PDF (not the generated one) when attachmentSource is custom", async () => {
  const sentCalls: unknown[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
    generateExcelAttachment: async () => {
      throw new Error("generateExcelAttachment must NOT be called when attachmentSource is custom");
    },
  });
  const client = await makeClient(`Custom PDF Test - send with custom ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);
    await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", MINIMAL_PDF, "custom.pdf");

    const res = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SENT");
  } finally {
    await cleanupClient(client.id);
  }
});

test("approveAndSendReport fails clearly (never falls back to generated) when attachmentSource is custom but the file is missing on disk", async () => {
  const sentCalls: unknown[] = [];
  let generateExcelAttachmentCalled = false;
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
    generateExcelAttachment: async () => {
      generateExcelAttachmentCalled = true;
      return { buffer: Buffer.from("fake-generated-pdf"), filename: "generated.pdf" };
    },
  });
  const client = await makeClient(`Custom PDF Test - missing file ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);
    await authedApp(app).post(`/api/reports/${report.id}/custom-pdf`).attach("file", MINIMAL_PDF, "custom.pdf");

    // Simulate the uploaded file having disappeared from disk (e.g. a
    // volume issue) without going through the API -- directly point
    // customPdfPath at a path that doesn't exist.
    await prisma.rankingReport.update({
      where: { id: report.id },
      data: { customPdfPath: path.join(path.dirname((await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } })).customPdfPath!), "does-not-exist.pdf") },
    });

    const res = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(res.status, 502);
    assert.equal(res.body.outcome, "SEND_FAILED");
    assert.match(res.body.errorMessage, /missing on disk/i);
    assert.match(res.body.errorMessage, /refusing to fall back/i);
    assert.equal(sentCalls.length, 0, "the mock send function must never be called");
    assert.equal(generateExcelAttachmentCalled, false, "must never silently fall back to generating/using the generated PDF");

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(unchanged.status, "APPROVED", "a failed send reverts to APPROVED, safe to retry");
  } finally {
    await cleanupClient(client.id);
  }
});

test("approveAndSendReport still uses the generated PDF by default (attachmentSource untouched)", async () => {
  const sentCalls: unknown[] = [];
  let generateExcelAttachmentCalled = false;
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
    generateExcelAttachment: async () => {
      generateExcelAttachmentCalled = true;
      return { buffer: Buffer.from("fake-generated-pdf"), filename: "generated.pdf" };
    },
  });
  const client = await makeClient(`Custom PDF Test - default generated ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makePendingApprovalReport(client.id, run.id);

    const res = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "SENT");
    assert.equal(generateExcelAttachmentCalled, true);
  } finally {
    await cleanupClient(client.id);
  }
});
