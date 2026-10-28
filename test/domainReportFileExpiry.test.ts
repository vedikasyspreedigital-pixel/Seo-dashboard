import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../backend/db/client.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { REPORT_FILES_KEEP_DAYS, domainReportDir, removeExpiredReportFiles } from "../backend/domainIntel/createDomainReport.js";

// Disk space (2026-10-26): Domain Intelligence files go 10 days after POSTING; reports that never
// reached ClickUp keep theirs (the server copy is the only one); the history row always stays.

const DAY = 24 * 60 * 60 * 1000;
const exists = (p: string) => stat(p).then(() => true, () => false);

test("removeExpiredReportFiles: posted 10+ days ago -> files deleted, row kept and marked; newer or unposted -> untouched", async () => {
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: "Expiry Test", domain: "expiry.test", workspaceId: auth.workspace.id } });
  const now = new Date();
  const make = async (status: string, postedDaysAgo: number | null, extraSummary: object = {}) => {
    const report = await prisma.domainReport.create({
      data: {
        clientId: client.id,
        websiteUrl: "expiry.test",
        sources: ["semrush"],
        reportMode: "combined",
        summary: { sources: { semrush: { keywords: 3 } }, ...extraSummary },
        files: [],
        status,
        postedAt: postedDaysAgo === null ? null : new Date(now.getTime() - postedDaysAgo * DAY),
        createdAt: new Date(now.getTime() - ((postedDaysAgo ?? 30) + 1) * DAY),
      },
    });
    const dir = domainReportDir(report.id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "report.xlsx");
    await writeFile(file, "x");
    await prisma.domainReport.update({ where: { id: report.id }, data: { files: [{ name: "report.xlsx", path: file }] } });
    return { id: report.id, dir };
  };
  const old = await make("POSTED", REPORT_FILES_KEEP_DAYS + 1);
  const recent = await make("POSTED", REPORT_FILES_KEEP_DAYS - 1);
  const neverPosted = await make("NOT_POSTED", null);
  const failed = await make("POST_FAILED", null);
  // Audit 2026-10-27: "posted" in test mode reached no ClickUp comment -- its files are the only copy.
  const mockPosted = await make("POSTED", REPORT_FILES_KEEP_DAYS + 5, { mockPosted: true });
  try {
    await removeExpiredReportFiles(now, client.id);

    const oldRow = await prisma.domainReport.findUniqueOrThrow({ where: { id: old.id } });
    assert.deepEqual(oldRow.files, []);
    assert.equal((oldRow.summary as { filesExpired?: boolean }).filesExpired, true);
    assert.equal((oldRow.summary as { sources?: object }).sources !== undefined, true, "the rest of the summary is kept");
    assert.equal(await exists(old.dir), false);

    for (const kept of [recent, neverPosted, failed, mockPosted]) {
      const row = await prisma.domainReport.findUniqueOrThrow({ where: { id: kept.id } });
      assert.equal((row.files as unknown[]).length, 1);
      assert.equal(await exists(kept.dir), true);
    }
    assert.equal(await removeExpiredReportFiles(now, client.id), 0, "running again changes nothing");
  } finally {
    for (const r of [old, recent, neverPosted, failed, mockPosted]) await rm(r.dir, { recursive: true, force: true });
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});
