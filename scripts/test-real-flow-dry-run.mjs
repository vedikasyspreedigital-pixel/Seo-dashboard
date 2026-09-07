// One-off, manual verification script for the "complete real flow up to
// the Email Agent opening the correct ClickUp task, without sending" test.
// Runs the actual API end to end (upload -> start -> poll -> create report
// -> build report -> generate email draft), then calls the REAL ClickUp
// automation directly in dryRun mode (stops right after attaching the
// PDF, never clicks Send) -- bypassing approveAndSendReport entirely so
// the report's status is never falsely marked SENT.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../backend/db/client.js";
import { generateExcelPdfAttachment } from "../backend/reporting/generateExcelAttachment.js";
import { createClickUpEmailSender } from "../backend/reporting/clickupEmailSender.js";
import { hashPassword } from "../backend/auth/password.js";

const BASE = "http://localhost:3001/api";
const CLIENT_NAME = "arnoldsfibreglass.com.au";
const EXCEL_PATH = "C:\\Users\\admin\\Downloads\\test-upload.xlsx";
const SCREENSHOT_PATH = "C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-emailsetup\\1bac8012-8fec-4748-bb79-6dfb773ea2d9\\scratchpad\\clickup-dry-run-composer.png";

let cookie;
async function api(pathSuffix, opts = {}) {
  const res = await fetch(`${BASE}${pathSuffix}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

// 1. Log in with a throwaway one-off script user (real session, real cookie).
const email = `flow-test-${Date.now()}@local.test`;
const user = await prisma.user.create({ data: { email, passwordHash: hashPassword("irrelevant") } });
const client = await prisma.client.findFirstOrThrow({ where: { name: CLIENT_NAME } });
await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId: client.workspaceId } });

try {
  const loginRes = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "irrelevant" }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
  console.log("1. Logged in.");

  // 2. Upload the real keyword file for the real client.
  const fileBuffer = await readFile(EXCEL_PATH);
  const form = new FormData();
  form.append("clientId", client.id);
  form.append("file", new Blob([fileBuffer]), "test-upload.xlsx");
  const uploadRes = await api("/runs", { method: "POST", body: form });
  const uploadBody = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`upload failed: ${JSON.stringify(uploadBody)}`);
  const runId = uploadBody.run.id;
  console.log(`2. Uploaded run ${runId} (${uploadBody.insertedRowCount} row(s)).`);

  // 3. Start the run -- this is the REAL DataForSEO call.
  const startRes = await api(`/runs/${runId}/start`, { method: "POST" });
  if (!startRes.ok) throw new Error(`start failed: ${await startRes.text()}`);
  console.log("3. Run started -- polling for completion (real DataForSEO call in flight)...");

  let status;
  for (let i = 0; i < 60; i++) {
    const progressRes = await api(`/runs/${runId}/progress`);
    const progress = await progressRes.json();
    status = progress.runStatus;
    if (status !== "PROCESSING") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`   Run finished with status: ${status}`);
  if (status !== "COMPLETED" && status !== "COMPLETED_WITH_ERRORS") throw new Error(`Run did not complete: ${status}`);

  // 4. Create the report (eager analytics, no Claude).
  const createReportRes = await api("/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  const createReportBody = await createReportRes.json();
  if (!createReportRes.ok) throw new Error(`create report failed: ${JSON.stringify(createReportBody)}`);
  const reportId = createReportBody.report.id;
  console.log(`4. Report created: ${reportId}`);

  // 5. Build Report -- generates the client PDF (Summary + Keyword Table).
  const buildRes = await api(`/reports/${reportId}/build-report`, { method: "POST" });
  const buildBody = await buildRes.json();
  if (!buildRes.ok) throw new Error(`build report failed: ${JSON.stringify(buildBody)}`);
  console.log(`5. Report built. PDF: ${buildBody.clientPdfPath}`);

  // 6. Generate Email Draft -- resolves recipients + ClickUp task from
  // ClientReportConfig, drives REPORT_READY -> PENDING_APPROVAL.
  const draftRes = await api(`/reports/${reportId}/generate-email-draft`, { method: "POST" });
  const draftBody = await draftRes.json();
  if (!draftRes.ok || draftBody.outcome !== "SUCCESS") throw new Error(`generate email draft failed: ${JSON.stringify(draftBody)}`);
  console.log("6. Email draft generated -> report is now PENDING_APPROVAL.");

  // 7. Fetch the report to see exactly what was persisted/resolved.
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
  console.log("7. Resolved for send:");
  console.log("   To:", report.resolvedRecipients);
  console.log("   Subject:", report.emailSubject);
  console.log("   ClickUp task URL (resolved from clickupTaskId):", report.resolvedClickupTaskUrl);

  // 8. The exact PDF that would be attached on a real send -- read from
  // disk, not regenerated (same file the PDF Preview page showed).
  const attachment = await generateExcelPdfAttachment(reportId);
  console.log(`8. PDF attachment ready: ${attachment.filename} (${attachment.buffer.length} bytes)`);

  // 9. The REAL ClickUp Email Agent -- dry run: opens the real task, fills
  // To/Subject/Body, attaches the PDF, screenshots it, and stops. Never
  // touches approveAndSendReport/markSent, so `report` stays PENDING_APPROVAL.
  console.log("9. Opening the real ClickUp task and filling the composer (dry run -- will NOT click Send)...");
  const sendEmail = createClickUpEmailSender({
    sessionStatePath: path.resolve("spikes/clickup-feasibility/session/clickup-storage-state.json"),
    headless: true,
    dryRun: true,
    dryRunScreenshotPath: SCREENSHOT_PATH,
  });
  const result = await sendEmail({
    to: report.resolvedRecipients,
    subject: report.emailSubject,
    bodyText: report.emailBody,
    bodyHtml: report.emailBodyHtml ?? undefined,
    clickupTaskUrl: report.resolvedClickupTaskUrl,
    excelPdfBuffer: attachment.buffer,
    excelPdfFilename: attachment.filename,
  });
  console.log("DRY RUN COMPLETE:", result);
  console.log(`Screenshot saved to: ${SCREENSHOT_PATH}`);

  const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
  console.log(`Final report status (must still be PENDING_APPROVAL -- nothing was actually sent): ${final.status}`);
} finally {
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}
