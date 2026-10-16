import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { ReportStatus } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import type { SendEmailParams } from "../backend/reporting/emailSender.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";

// Extra PDFs (e.g. Google Analytics reports) uploaded on the email draft page
// and sent TOGETHER WITH the report PDF, plus the Regular / GA email template
// toggle (2026-10-16). Same for SEO and Advanced SEO -- nothing here depends
// on the workspace.

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});

const authedApp = (app: ReturnType<typeof createApp>) => authedRequest(app, auth.cookieHeader);
const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });
const PDF = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF`);

async function setup(status: ReportStatus = ReportStatus.PENDING_APPROVAL) {
  const client = await prisma.client.create({ data: { name: `Extra PDFs ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const run = await prisma.rankingRun.create({
    data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "local-test/x.xlsx", totalRows: 1, status: "COMPLETED", createdAt: new Date("2026-10-14T05:00:00Z"), completedAt: new Date("2026-10-14T06:00:00Z") },
  });
  const report = await prisma.rankingReport.create({
    data: {
      clientId: client.id,
      runId: run.id,
      status,
      reportDate: new Date("2026-10-15T00:00:00Z"),
      analyticsJson: { totals: { totalKeywords: 1, averageRank: 5, top3Count: 1, top10Count: 1, notIn100Count: 0 }, movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] } },
      emailSubject: "Edited subject",
      emailBody: "Regular body",
      resolvedRecipients: ["ops@example.com"],
    },
  });
  return { client, run, report };
}

async function cleanup(clientId: string) {
  const reports = await prisma.rankingReport.findMany({ where: { clientId } });
  for (const r of reports) {
    for (const a of (r.extraAttachments as { path: string }[]) ?? []) await unlink(a.path).catch(() => undefined);
  }
  await prisma.reportSend.deleteMany({ where: { report: { clientId } } });
  await prisma.rankingBaselineRow.deleteMany({ where: { baseline: { clientId } } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("extra PDFs: upload several, names kept and made unique, sent TOGETHER WITH the report PDF", async () => {
  const sent: SendEmailParams[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sent.push(p)),
    generateExcelAttachment: async () => ({ buffer: PDF("report"), filename: "Client - Keyword Ranking Report.pdf" }),
  });
  const { client, report } = await setup();
  try {
    const up = await authedApp(app)
      .post(`/api/reports/${report.id}/extra-attachments`)
      .attach("files", PDF("ga1"), "Traffic Acquisition.pdf")
      .attach("files", PDF("ga2"), "Engagement Overview.pdf");
    assert.equal(up.status, 200);
    assert.deepEqual(up.body.extraAttachments.map((a: { filename: string }) => a.filename), ["Traffic Acquisition.pdf", "Engagement Overview.pdf"]);

    const again = await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", PDF("ga3"), "Traffic Acquisition.pdf");
    assert.equal(again.status, 200);
    assert.equal(again.body.extraAttachments[2].filename, "Traffic Acquisition (2).pdf", "same name is made unique");

    const sendRes = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(sendRes.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].excelPdfFilename, "Client - Keyword Ranking Report.pdf", "the report PDF is still attached");
    assert.deepEqual(sent[0].extraAttachments?.map((a) => a.filename), ["Traffic Acquisition.pdf", "Engagement Overview.pdf", "Traffic Acquisition (2).pdf"]);
    assert.match(sent[0].extraAttachments![1].buffer.toString(), /ga2/);
  } finally {
    await cleanup(client.id);
  }
});

test("extra PDFs: non-PDFs and too many files are refused; remove deletes the file", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const { client, report } = await setup();
  try {
    const bad = await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", Buffer.from("hello"), "notes.pdf");
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not a PDF/);

    let req = authedApp(app).post(`/api/reports/${report.id}/extra-attachments`);
    for (let i = 0; i < 6; i++) req = req.attach("files", PDF(`f${i}`), `f${i}.pdf`);
    const tooMany = await req;
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /at most 5/i);

    const up = await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", PDF("a"), "a.pdf").attach("files", PDF("b"), "b.pdf");
    const [first, second] = up.body.extraAttachments as { id: string; path: string }[];
    const del = await authedApp(app).delete(`/api/reports/${report.id}/extra-attachments/${first.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.extraAttachments.map((a: { id: string }) => a.id), [second.id]);
    await assert.rejects(access(first.path), "removed file is deleted from disk");

    assert.equal((await authedApp(app).delete(`/api/reports/${report.id}/extra-attachments/${first.id}`)).status, 404);
  } finally {
    await cleanup(client.id);
  }
});

test("extra PDFs: a file missing at send time fails the send instead of sending without it", async () => {
  const sent: SendEmailParams[] = [];
  const app = createApp(unusedDataForSeoMock, "mock", undefined, { sendEmail: createMockEmailSender((p) => sent.push(p)) });
  const { client, report } = await setup();
  try {
    const up = await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", PDF("ga"), "GA.pdf");
    await unlink(up.body.extraAttachments[0].path);
    const res = await authedApp(app).post(`/api/reports/${report.id}/approve-and-send`).send({});
    assert.equal(res.body.outcome, "SEND_FAILED");
    assert.match(res.body.errorMessage, /"GA\.pdf" is missing/);
    assert.equal(sent.length, 0, "nothing was sent");
  } finally {
    await cleanup(client.id);
  }
});

test("extra PDFs and template can only change while the report awaits approval", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const { client, report } = await setup(ReportStatus.SENT);
  try {
    assert.equal((await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", PDF("x"), "x.pdf")).status, 409);
    assert.equal((await authedApp(app).post(`/api/reports/${report.id}/email-variant`).send({ variant: "ga" })).status, 409);
    const reports = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.deepEqual(reports.extraAttachments, [], "nothing recorded");
  } finally {
    await cleanup(client.id);
  }
});

test("deleting a run (Runs page) also deletes its report's extra PDFs from disk", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const { client, run, report } = await setup();
  try {
    const up = await authedApp(app).post(`/api/reports/${report.id}/extra-attachments`).attach("files", PDF("ga"), "GA.pdf");
    const stored = up.body.extraAttachments[0].path as string;
    await access(stored);
    assert.equal((await authedApp(app).delete(`/api/runs/${run.id}`)).status, 204);
    await assert.rejects(access(stored), "extra PDF deleted with the run");
    assert.equal(await prisma.rankingReport.count({ where: { id: report.id } }), 0);
  } finally {
    await cleanup(client.id);
  }
});

test("email template toggle: GA body with the period and placeholders; subject and recipients untouched; Regenerate keeps GA", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const { client, report } = await setup();
  try {
    assert.equal((await authedApp(app).post(`/api/reports/${report.id}/email-variant`).send({ variant: "other" })).status, 400);

    const ga = await authedApp(app).post(`/api/reports/${report.id}/email-variant`).send({ variant: "ga" });
    assert.equal(ga.status, 200);
    assert.equal(ga.body.emailVariant, "ga");
    assert.equal(ga.body.emailSubject, "Edited subject", "subject edits are kept");
    assert.deepEqual(ga.body.resolvedRecipients, ["ops@example.com"]);
    assert.match(ga.body.emailBody, /website ranking report for 14th October 2026 - 15th October 2026/);
    assert.match(ga.body.emailBody, /Google Analytics reports \(Traffic Acquisition and Engagement Overview\)/);
    assert.match(ga.body.emailBody, /\[organic search users\] organic search users and \[event count\] event counts for \[month\]/);

    const regen = await authedApp(app).post(`/api/reports/${report.id}/regenerate`).send({});
    assert.equal(regen.status, 200);
    assert.match(regen.body.bodyText, /Google Analytics reports/, "Regenerate keeps the GA template");

    const back = await authedApp(app).post(`/api/reports/${report.id}/email-variant`).send({ variant: "regular" });
    assert.equal(back.body.emailVariant, "regular");
    assert.match(back.body.emailBody, /^Dear Client,\n\nPleased to attach your website ranking report/);
    assert.doesNotMatch(back.body.emailBody, /Google Analytics/);
  } finally {
    await cleanup(client.id);
  }
});
