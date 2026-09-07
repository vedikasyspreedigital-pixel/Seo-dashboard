import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prisma } from "../backend/db/client.js";
import { generateExcelPdfAttachment } from "../backend/reporting/generateExcelAttachment.js";
import { ReportStatus } from "@prisma/client";

// Confirms generateExcelPdfAttachment reads the STORED PDF (written by
// buildReport) rather than regenerating one -- this is the "one artifact"
// guarantee: whatever the PDF Preview page showed is byte-identical to what
// gets attached to the email.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "excel-attachment-test.xlsx",
      sourceFilePath: "local-test/excel-attachment-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
      completedAt: new Date("2026-01-15T00:00:00Z"),
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

test("generateExcelPdfAttachment reads the exact bytes already stored at clientPdfPath, without regenerating", async () => {
  const client = await makeClient(`Excel Attachment Test - reads stored file ${randomUUID()}`);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "report-pdf-test-"));
  try {
    const run = await makeRun(client.id);
    const storedPath = path.join(tmpDir, `${randomUUID()}.pdf`);
    const fakePdfBytes = Buffer.from("%PDF-1.4 fake report bytes for test identity check");
    await writeFile(storedPath, fakePdfBytes);

    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        status: ReportStatus.REPORT_READY,
        analyticsJson: { totals: { totalKeywords: 1 } },
        clientPdfPath: storedPath,
      },
    });

    const attachment = await generateExcelPdfAttachment(report.id);
    assert.ok(attachment.buffer.equals(fakePdfBytes), "attachment bytes must be byte-identical to the stored artifact");
    assert.match(attachment.filename, /\.pdf$/);
    assert.match(attachment.filename, /2026-01-15/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await cleanupClient(client.id);
  }
});

test("generateExcelPdfAttachment throws a clear error when the report has no stored PDF yet", async () => {
  const client = await makeClient(`Excel Attachment Test - missing pdf ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        status: ReportStatus.PENDING_ANALYSIS,
        analyticsJson: { totals: { totalKeywords: 1 } },
      },
    });

    await assert.rejects(() => generateExcelPdfAttachment(report.id), /no clientPdfPath/);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
