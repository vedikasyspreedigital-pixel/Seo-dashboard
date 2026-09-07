import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { updateReportDraft } from "../backend/reporting/editReportDraft.js";
import { InvalidReportTransitionError } from "../backend/reporting/errors.js";
import { ReportStatus } from "@prisma/client";

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: { clientId, sourceFilename: "edit-draft-test.xlsx", sourceFilePath: "local-test/edit-draft-test.xlsx", totalRows: 1, status: "COMPLETED" },
  });
}

async function makeReport(clientId: string, runId: string, status: ReportStatus) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status,
      emailSubject: "Original subject",
      emailBody: "Original body",
      resolvedRecipients: ["a@example.com"],
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

test("recipient editing: subject, body, recipients, and ClickUp task URL can be edited while PENDING_APPROVAL", async () => {
  const client = await makeClient(`Edit Draft Test - success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(report.id, {
      emailSubject: "Edited subject",
      resolvedRecipients: ["a@example.com", "b@example.com"],
      resolvedClickupTaskUrl: "https://app.clickup.com/t/abc123",
    });

    assert.equal(updated.emailSubject, "Edited subject");
    assert.equal(updated.emailBody, "Original body"); // untouched field survives a partial edit
    assert.deepEqual(updated.resolvedRecipients, ["a@example.com", "b@example.com"]);
    assert.equal(updated.resolvedClickupTaskUrl, "https://app.clickup.com/t/abc123");
    assert.equal(updated.status, ReportStatus.PENDING_APPROVAL); // editing never changes status

    const cleared = await updateReportDraft(report.id, { resolvedClickupTaskUrl: null });
    assert.equal(cleared.resolvedClickupTaskUrl, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("emailBody persists on its own, independent of the other fields", async () => {
  const client = await makeClient(`Edit Draft Test - body only ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(report.id, { emailBody: "Edited body only" });
    assert.equal(updated.emailBody, "Edited body only");
    assert.equal(updated.emailSubject, "Original subject"); // untouched

    // Refetch as a completely separate read, proving this isn't just the
    // update call echoing its own input back.
    const refetched = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(refetched.emailBody, "Edited body only");
  } finally {
    await cleanupClient(client.id);
  }
});

for (const otherStatus of [ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFTED, ReportStatus.SENT, ReportStatus.REJECTED]) {
  test(`recipient editing is refused when the report is ${otherStatus}, not silently applied`, async () => {
    const client = await makeClient(`Edit Draft Test - refused ${otherStatus} ${randomUUID()}`);
    try {
      const run = await makeRun(client.id);
      const report = await makeReport(client.id, run.id, otherStatus);

      await assert.rejects(
        () => updateReportDraft(report.id, { emailSubject: "Should not apply" }),
        InvalidReportTransitionError,
      );

      const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
      assert.equal(unchanged.emailSubject, "Original subject");
    } finally {
      await cleanupClient(client.id);
    }
  });
}

test.after(async () => {
  await prisma.$disconnect();
});
