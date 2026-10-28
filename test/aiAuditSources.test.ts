import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditJobError, clearAuditJobs, getAudit, startAudit } from "../backend/domainIntel/auditJob.js";
import type { AiAuditWriter } from "../backend/domainIntel/aiSeoAudit.js";

// Audit 2026-10-27: the AI SEO Audit read the client's newest Site Audit / WooRank of ANY website from the
// last week. Now: same website only -- and a run passes exactly its own audits (sourceIds).

const pdf = (name: string) => async () => ({ buffer: Buffer.from(`%PDF-1.4 ${name}`), fileName: `${name}.pdf` });
const waitDone = async (id: string) => {
  for (let i = 0; i < 100 && ["queued", "running"].includes(getAudit(id)!.state); i++) await new Promise((r) => setTimeout(r, 10));
  return getAudit(id)!;
};

test("AI SEO Audit: reads only audits of the same website, and exactly a run's own audits when given", async () => {
  clearAuditJobs();
  const client = { id: `client-${randomUUID()}`, workspaceId: null, name: "Yoga Peace" };
  const read: string[][] = [];
  const aiWriter: AiAuditWriter = async ({ sources }) => {
    read.push(sources.map((s) => s.buffer.toString("latin1").slice(9)));
    return { buffer: Buffer.from("PK ai"), fileName: "ai.xlsx" };
  };
  try {
    const older = await startAudit({ kind: "woorank", client, websiteUrl: "https://yogapeace.com.au" }, { woorank: pdf("old-woorank") });
    await waitDone(older.id);
    const site = await startAudit({ kind: "siteaudit", client, websiteUrl: "https://www.yogapeace.com.au/" }, { siteaudit: pdf("site-audit") });
    await waitDone(site.id);

    // Another website of the same client: nothing of its own to read -> refused, never yogapeace.com.au's audits.
    await assert.rejects(startAudit({ kind: "aiaudit", client, websiteUrl: "https://othersite.com.au" }, {}, aiWriter), (err) => err instanceof AuditJobError && /for this website/.test(err.message));

    // The same website (www / trailing slash don't matter): its newest of each kind.
    const ai = await startAudit({ kind: "aiaudit", client, websiteUrl: "yogapeace.com.au" }, {}, aiWriter);
    assert.equal((await waitDone(ai.id)).state, "done");
    assert.deepEqual(read.at(-1)!.sort(), ["old-woorank", "site-audit"]);

    // A run passes its own audits: only those are read, never an older one of the same kind.
    const ai2 = await startAudit({ kind: "aiaudit", client, websiteUrl: "yogapeace.com.au", sourceIds: [site.id] }, {}, aiWriter);
    assert.equal((await waitDone(ai2.id)).state, "done");
    assert.deepEqual(read.at(-1), ["site-audit"]);
  } finally {
    clearAuditJobs();
  }
});
