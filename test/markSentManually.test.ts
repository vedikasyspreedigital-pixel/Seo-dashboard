import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { promoteMissingBaselines } from "../backend/reporting/processVerifiedExcelUpload.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Mark as sent manually" (2026-11-06): the team sent the report outside the dashboard (Kalessie 3 Nov --
// the dashboard send died when the server restarted, they sent their own report from ClickUp). The report
// must become SENT without any email, and the file they actually sent must become the baseline.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("no DataForSEO here");
};

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});

const KEYWORDS = ["gold earrings uae", "anklets online", "nose pin uae", "zodiac necklace"];

async function setup(status: ReportStatus = ReportStatus.APPROVED) {
  const sentCalls: unknown[] = [];
  const app = createApp(neverCalled, "mock", undefined, {
    sendEmail: createMockEmailSender((p) => sentCalls.push(p)),
  });
  const api = authedRequest(app, auth.cookieHeader);
  const client = await prisma.client.create({ data: { name: `Manual send ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const run = await prisma.rankingRun.create({
    data: { clientId: client.id, sourceFilename: "Kalessie.xlsx", sourceFilePath: "x", totalRows: KEYWORDS.length, status: "COMPLETED", completedAt: new Date("2026-11-03T08:00:00Z") },
  });
  for (const [i, keyword] of KEYWORDS.entries()) {
    await prisma.rankingRow.create({
      data: {
        runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*kalessie.*", locationName: "United Arab Emirates",
        seDomain: "google.ae", languageName: "English", status: "COMPLETED", rankValue: 50, rankDisplay: "50",
      },
    });
  }
  const report = await prisma.rankingReport.create({
    data: {
      clientId: client.id, runId: run.id, status, verifiedFilename: "Kalessie Automation Template (8).xlsx", reportDate: new Date("2026-11-03T12:35:00Z"),
      analyticsJson: {}, reportHtml: "<html>generated</html>", emailSubject: "Kalessie Keyword Ranking Report", emailBody: "Hi", resolvedRecipients: ["client@example.com"],
      lastErrorMessage: status === ReportStatus.APPROVED ? "The server restarted while this was being sent" : null,
    },
  });
  const cleanup = async () => {
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: { in: baselines.map((b) => b.id) } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.reportSend.deleteMany({ where: { reportId: report.id } });
    await prisma.rankingReport.deleteMany({ where: { clientId: client.id } });
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  };
  return { api, client, run, report, sentCalls, cleanup };
}

/** The team's own report: a 15 Oct and a 3 Nov column; the 3 Nov ranks (different from the run's 50s) are what the client saw. */
async function sentReportFile(keywords = KEYWORDS): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rankings");
  sheet.addRow(["Current Ranking Status:", "Google.ae", "Google.ae"]);
  sheet.addRow(["Keyword", "3rd November 2026", "15th October 2026"]);
  keywords.forEach((k, i) => sheet.addRow([k, i === 3 ? "Not in 100" : String(i + 1), "40"]));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("mark sent manually: preview reads the sent file; confirm makes the report SENT with no email, and the FILE's ranks become the baseline", async () => {
  const t = await setup();
  try {
    const preview = await t.api.post(`/api/reports/${t.report.id}/sent-manually/preview`).attach("file", await sentReportFile(), "Kalessie final report.xlsx");
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.baselineDateLabel, "3rd November 2026");
    assert.equal(preview.body.matchedKeywords, 4);
    assert.equal(preview.body.totalKeywords, 4);
    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: t.client.id } }), 0, "preview writes nothing");

    const res = await t.api.post(`/api/reports/${t.report.id}/sent-manually`).send({
      sourceFilename: preview.body.sourceFilename, sourceType: preview.body.sourceType, baselineDate: preview.body.baselineDate,
      sentAt: "2026-11-03T13:00:00.000Z", rows: preview.body.rows,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(t.sentCalls.length, 0, "no email is sent");

    const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: t.report.id }, include: { sends: true } });
    assert.equal(report.status, ReportStatus.SENT);
    assert.equal(report.sentAt?.toISOString(), "2026-11-03T13:00:00.000Z");
    assert.equal(report.lastErrorMessage, null);
    assert.equal(report.sends.length, 1);
    assert.equal(report.sends[0].manual, true);
    assert.equal(report.sends[0].sourceFilename, "Kalessie final report.xlsx");

    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: t.client.id }, include: { rows: true } });
    assert.equal(baselines.length, 1);
    assert.equal(baselines[0].sourceRunId, t.run.id, "it is this run's baseline");
    assert.equal(baselines[0].sourceFilename, "Kalessie final report.xlsx");
    assert.equal(baselines[0].baselineDate.toISOString().slice(0, 10), "2026-11-03");
    const rank = (k: string) => baselines[0].rows.find((r) => r.keyword === k)?.rankValue;
    assert.equal(rank("gold earrings uae"), 1, "the sent file's rank, not the run's 50");
    assert.equal(rank("zodiac necklace"), null, "Not in 100");

    // The hourly "missing baseline" repair must not overwrite it with the generated report's ranks.
    await promoteMissingBaselines();
    const after = await prisma.rankingBaseline.findMany({ where: { clientId: t.client.id }, include: { rows: true } });
    assert.equal(after.length, 1);
    assert.equal(after[0].rows.find((r) => r.keyword === "gold earrings uae")?.rankValue, 1);

    const again = await t.api.post(`/api/reports/${t.report.id}/sent-manually`).send({
      sourceFilename: "x.xlsx", sourceType: "EXCEL", baselineDate: "2026-11-03", sentAt: "2026-11-03T13:00:00.000Z", rows: preview.body.rows,
    });
    assert.equal(again.status, 409, "an already-sent report can't be marked again");
  } finally {
    await t.cleanup();
  }
});

test("mark sent manually: another client's file (few matching keywords) is refused and nothing changes", async () => {
  const t = await setup(ReportStatus.PENDING_APPROVAL);
  try {
    const preview = await t.api
      .post(`/api/reports/${t.report.id}/sent-manually/preview`)
      .attach("file", await sentReportFile(["car wash dubai", "car polish", "nose pin uae", "ceramic coating"]), "Other client.xlsx");
    assert.equal(preview.status, 200);
    assert.equal(preview.body.matchedKeywords, 1);

    const res = await t.api.post(`/api/reports/${t.report.id}/sent-manually`).send({
      sourceFilename: "Other client.xlsx", sourceType: "EXCEL", baselineDate: preview.body.baselineDate, sentAt: "2026-11-03T13:00:00.000Z", rows: preview.body.rows,
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /only 1 of this report's 4 keywords/);
    const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: t.report.id } });
    assert.equal(report.status, ReportStatus.PENDING_APPROVAL);
    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: t.client.id } }), 0);
    assert.equal(await prisma.reportSend.count({ where: { reportId: t.report.id } }), 0);
  } finally {
    await t.cleanup();
  }
});

test("mark sent manually: refused for a rejected report, bad ranks, a future date, or no file", async () => {
  const t = await setup(ReportStatus.REJECTED);
  try {
    const rows = KEYWORDS.map((keyword) => ({ keyword, rankValue: 3, rankDisplay: "3" }));
    const send = (b: object) =>
      t.api.post(`/api/reports/${t.report.id}/sent-manually`).send({ sourceFilename: "f.xlsx", sourceType: "EXCEL", baselineDate: "2026-11-03", sentAt: "2026-11-03T13:00:00.000Z", rows, ...b });
    assert.equal((await send({})).status, 409, "rejected stays final");

    await prisma.rankingReport.update({ where: { id: t.report.id }, data: { status: ReportStatus.APPROVED } });
    assert.equal((await send({ rows: [{ keyword: "gold earrings uae", rankValue: 0, rankDisplay: "0" }] })).status, 400);
    assert.equal((await send({ sentAt: new Date(Date.now() + 3 * 86400000).toISOString() })).status, 400);
    assert.equal((await t.api.post(`/api/reports/${t.report.id}/sent-manually/preview`)).status, 400);
    assert.equal((await prisma.rankingReport.findUniqueOrThrow({ where: { id: t.report.id } })).status, ReportStatus.APPROVED, "nothing changed");
  } finally {
    await t.cleanup();
  }
});
