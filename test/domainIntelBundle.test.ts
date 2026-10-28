import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { clearFetchJobs } from "../backend/domainIntel/fetchJob.js";
import { clearCompetitorSearches } from "../backend/domainIntel/competitorJob.js";
import { clearAuditJobs } from "../backend/domainIntel/auditJob.js";
import { clearBundles, startBundle, type BundleReport } from "../backend/domainIntel/bundleJob.js";
import { FetchError, type FetchExportFn } from "../backend/domainIntel/fetchers/flikoverAhrefs.js";
import type { PostCommentParams } from "../backend/domainIntel/clickupCommentPoster.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Run all 5 reports" (2026-10-26): one click -> keywords (+ competitors, gap), Site Audit, WooRank,
// AI audit -> ONE ClickUp comment with every file. The tools are stand-ins here.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};

const HEADER = '"Keyword","Position","Search Volume","Keyword Difficulty","URL","Traffic","Keyword Intents"';
const semrushCsv = (site: string, rows: [string, number, number][]) => [HEADER, ...rows.map(([k, pos, traffic]) => `"${k}","${pos}","500","30","https://${site}/","${traffic}","commercial"`)].join("\n");
const PAGES: Record<string, [string, number, number][]> = {
  "yogapeace.com.au": [["yoga parramatta", 1, 300]],
  "c1.com.au": [["yoga parramatta", 4, 40], ["hot yoga sydney", 2, 250]],
  "c2.com.au": [["yin yoga", 3, 70]],
  "c3.com.au": [["prenatal yoga", 5, 20]],
};

async function setup(opts: { woorankFails?: boolean; woorankCalls?: number; ahrefsSignedOut?: boolean; clientName?: string } = {}) {
  clearFetchJobs();
  clearCompetitorSearches();
  clearAuditJobs();
  clearBundles();
  const auth = await createAuthenticatedSession();
  const posted: PostCommentParams[] = [];
  const calls = { siteaudit: 0, woorank: 0, aiaudit: 0, semrush: 0 };
  const pdf = (name: string) => ({ buffer: Buffer.from(`%PDF-1.4 ${name}`), fileName: name });
  const semrush: FetchExportFn = async ({ domain }) => (calls.semrush++, { buffer: Buffer.from(semrushCsv(domain, PAGES[domain] ?? [])), fileName: `${domain}-semrush.csv` });
  const competitorFetcher: FetchExportFn = async () => ({
    buffer: Buffer.from(["Domain,Com. Level rank,Com. Keywords,SE Keywords", "c1.com.au,1,52,206", "c2.com.au,2,43,74", "c3.com.au,3,33,370", "c4.com.au,4,1,1"].join("\n")),
    fileName: "competitors.csv",
  });
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async (p) => {
      posted.push(p);
      await new Promise((r) => setTimeout(r, 50)); // a post takes a while -- room for a second click to race it
    },
    classifyWithAi: null,
    fetchers: {
      semrush,
      ...(opts.ahrefsSignedOut
        ? { ahrefs: (async () => { throw new FetchError("SESSION_EXPIRED", "Flikover is signed out in the office Chrome."); }) as FetchExportFn }
        : {}),
    },
    competitorFetcher,
    auditFetchers: {
      siteaudit: async () => (calls.siteaudit++, pdf("site-audit.pdf")),
      woorank: async () => {
        opts.woorankCalls = (opts.woorankCalls ?? 0) + 1;
        calls.woorank++;
        if (opts.woorankFails) throw new Error("seotooladda is signed out");
        return pdf("woorank.pdf");
      },
    },
    aiAuditWriter: async ({ sources }) => (calls.aiaudit++, { buffer: Buffer.from(`PK ai audit from ${sources.length}`), fileName: "ai-seo-audit.xlsx" }),
    bundlePollMs: 10,
  });
  const client = await prisma.client.create({ data: { name: opts.clientName ?? "Yoga Peace", domain: "https://yogapeace.com.au", workspaceId: auth.workspace.id, domainReportTaskId: "86dbundle1" } });
  const api = authedRequest(app, auth.cookieHeader);
  const waitBundle = async (id: string) => {
    let body = (await api.get(`/api/domain-intel/bundles/${id}`)).body;
    for (let i = 0; i < 400 && body.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      body = (await api.get(`/api/domain-intel/bundles/${id}`)).body;
    }
    return body;
  };
  const cleanup = async () => {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
    clearFetchJobs();
    clearCompetitorSearches();
    clearAuditJobs();
    clearBundles();
  };
  return { api, client, posted, calls, waitBundle, cleanup };
}

test("Run all 5 reports: competitors found, every part done, ONE ClickUp comment with all 5 files", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, location: "au", sources: ["semrush"], competitors: "auto" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const again = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: "auto" });
    assert.equal(again.body.id, started.body.id, "a double-click doesn't start a second run");

    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "done", JSON.stringify(done.parts));
    assert.deepEqual(Object.fromEntries(Object.entries(done.parts).map(([k, v]) => [k, (v as { state: string }).state])), {
      keywords: "done",
      gap: "done",
      siteaudit: "done",
      woorank: "done",
      aiaudit: "done",
      post: "done",
    });
    assert.deepEqual(done.competitors, ["c1.com.au", "c2.com.au", "c3.com.au"]);

    assert.equal(t.posted.length, 1, "one comment");
    const names = t.posted[0].files.map((f) => f.name.replace(/ - \d.*?(\.\w+)$/, "$1"));
    assert.deepEqual(names, [
      "Yoga Peace - Domain Keyword Report.xlsx",
      "Yoga Peace - Gap & Competitor Analysis.xlsx",
      "Yoga Peace - Semrush Site Audit.pdf",
      "Yoga Peace - WooRank Audit.pdf",
      "Yoga Peace - AI SEO Audit.xlsx",
    ]);
    assert.equal(t.posted[0].taskId, "86dbundle1");
    assert.equal(t.posted[0].lines[0], "Hii @Farid Ansari sir, here is the Seo reports and Audit for https://yogapeace.com.au", "the team's wording");
    assert.equal(t.posted[0].mention, "Farid Ansari", "a real ClickUp tag");
    assert.match(t.posted[0].lines[1], /^Ref DI-[0-9a-f]{8}$/);

    // The page finds the run again after a reload, and the audit cards see its audits.
    assert.equal((await t.api.get(`/api/domain-intel/bundles?clientId=${t.client.id}`)).body.id, started.body.id);
    const audits = (await t.api.get(`/api/domain-intel/audits?clientId=${t.client.id}`)).body;
    assert.deepEqual(Object.keys(audits).sort(), ["aiaudit", "siteaudit", "woorank"]);
    assert.equal(audits.woorank.state, "done");
    assert.equal(audits.woorank.filePath, undefined, "server paths never reach the browser");
  } finally {
    await t.cleanup();
  }
});

test("Run all 5 reports: a failed part doesn't stop the rest; nothing is posted until all 5 are there", async () => {
  const tools = { woorankFails: true, woorankCalls: 0 };
  const t = await setup(tools);
  try {
    const started = await t.api
      .post("/api/domain-intel/bundles")
      .send({ clientId: t.client.id, sources: ["semrush"], competitors: ["https://www.c1.com.au/x", "c1.com.au", "yogapeace.com.au", "not a site"] });
    assert.equal(started.status, 202);
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "attention");
    assert.equal(done.parts.woorank.state, "failed");
    assert.match(done.parts.woorank.error, /signed out/);
    assert.equal(done.parts.siteaudit.state, "done");
    // The user's choice (2026-10-27): the AI audit uses only THIS run's Site Audit AND WooRank -- it no longer
    // runs from the Site Audit alone (and never picks up an older WooRank instead).
    assert.equal(done.parts.aiaudit.state, "skipped");
    assert.match(done.parts.aiaudit.step, /Needs this run's WooRank Audit -- retry it in Audits/);
    assert.equal(done.parts.post.state, "waiting");
    assert.equal(t.posted.length, 0, "not posted automatically");
    assert.deepEqual(done.competitors, ["c1.com.au"], "cleaned: URL -> domain, duplicates, the client itself and junk dropped");
    assert.equal(tools.woorankCalls, 2, "a failed audit is retried once by itself");
    const report = await prisma.domainReport.findUniqueOrThrow({ where: { id: done.reportId } });
    assert.equal((report.files as unknown[]).length, 3, "the 3 ready files are in the report (keywords, gap, site audit)");
    assert.equal(report.status, "NOT_POSTED", "held back, not 'waiting to post'");

    // The team fixes the cause, retries WooRank in the Audits section, then runs the AI audit there; the run picks both up.
    tools.woorankFails = false;
    const retry = await t.api.post("/api/domain-intel/audits").send({ kind: "woorank", clientId: t.client.id });
    assert.equal(retry.status, 202);
    const syncedPart = async (part: string) => {
      let body = (await t.api.get(`/api/domain-intel/bundles/${started.body.id}`)).body;
      for (let i = 0; i < 100 && body.parts[part].state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 20));
        body = (await t.api.get(`/api/domain-intel/bundles/${started.body.id}`)).body;
      }
      return body;
    };
    assert.equal((await syncedPart("woorank")).parts.woorank.state, "done");
    assert.equal((await t.api.post("/api/domain-intel/audits").send({ kind: "aiaudit", clientId: t.client.id })).status, 202);
    const synced = await syncedPart("aiaudit");
    assert.equal(synced.parts.aiaudit.state, "done");
    assert.match(synced.parts.post.step, /All 5 reports are ready/);

    // "Post all 5 files": the retried WooRank file is added, then ONE comment with all 5.
    const posted = await t.api.post(`/api/domain-intel/bundles/${started.body.id}/post`);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.state, "done");
    assert.equal(posted.body.parts.post.state, "done");
    assert.equal(t.posted.length, 1);
    assert.deepEqual(
      t.posted[0].files.map((f) => f.name.replace(/ - \d.*?(\.\w+)$/, "$1")),
      [
        "Yoga Peace - Domain Keyword Report.xlsx",
        "Yoga Peace - Gap & Competitor Analysis.xlsx",
        "Yoga Peace - Semrush Site Audit.pdf",
        "Yoga Peace - WooRank Audit.pdf",
        "Yoga Peace - AI SEO Audit.xlsx",
      ],
      "all 5, including the WooRank and AI audit made after the run",
    );
  } finally {
    await t.cleanup();
  }
});

test("Run all 5 reports: a keyword tool that drops out is named, with its reason, on the finished row", async () => {
  const t = await setup({ ahrefsSignedOut: true });
  try {
    // ahrefs is a "fetchable" tool here whose export fails like a signed-out Flikover.
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush", "ahrefs"], competitors: [] });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.parts.keywords.state, "done");
    assert.match(done.parts.keywords.error, /Without Ahrefs \(Flikover is signed out/);
  } finally {
    await t.cleanup();
  }
});

test("Run all 5 reports: needs a fetchable keyword tool", async () => {
  const t = await setup();
  try {
    const res = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["ahrefs"] });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /fetched automatically/);
  } finally {
    await t.cleanup();
  }
});

// Audit 2026-10-27: nothing stopped a second "Post" on a finished run, and the history's Retry could start a
// second post while one was running -- both mean a duplicate ClickUp comment.
test("Run all 5 reports: posting again after it's posted is refused -- one comment only", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: [] });
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.parts.post.state, "done");
    const again = await t.api.post(`/api/domain-intel/bundles/${started.body.id}/post`);
    assert.equal(again.status, 409);
    const retry = await t.api.post(`/api/domain-intel/reports/${done.reportId}/post`);
    assert.equal(retry.status, 409, "the history's Retry refuses a posted report");
    assert.equal(t.posted.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("Domain report: two Retry clicks at once post ONE comment", async () => {
  const t = await setup({ woorankFails: true });
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: [] });
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "attention", "held back, so the report is NOT_POSTED and retryable");
    const [a, b] = await Promise.all([t.api.post(`/api/domain-intel/reports/${done.reportId}/post`), t.api.post(`/api/domain-intel/reports/${done.reportId}/post`)]);
    for (const r of [a, b]) assert.ok([202, 409].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    for (let i = 0; i < 100; i++) {
      const r = await prisma.domainReport.findUniqueOrThrow({ where: { id: done.reportId } });
      if (r.status === "POSTED") break;
      await new Promise((res) => setTimeout(res, 20));
    }
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(t.posted.length, 1, "one comment, however the clicks raced");
  } finally {
    await t.cleanup();
  }
});

test("Run all 5 reports: a client name with '/' gives safe file names (the poster saves files under them)", async () => {
  const t = await setup({ clientName: "Yoga/Peace\nStudio" });
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: [] });
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.parts.post.state, "done", JSON.stringify(done.parts));
    for (const f of t.posted[0].files) {
      assert.doesNotMatch(f.name, /[\\/\n]/, f.name);
      assert.ok(f.name.startsWith("YogaPeaceStudio - "), f.name);
    }
  } finally {
    await t.cleanup();
  }
});

// Pick the reports (user's request, 2026-10-27): only the ticked ones run, and only their files are posted.
const postedNames = (t: { posted: PostCommentParams[] }) => t.posted[0].files.map((f) => f.name.replace(/ - \d.*?(\.\w+)$/, "$1"));

test("Pick reports: Keyword Analysis only -- no audits run, one comment with just that file", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: ["c1.com.au"], reports: ["keywords"] });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "done", JSON.stringify(done.parts));
    assert.deepEqual(done.selected, ["keywords"]);
    for (const p of ["gap", "siteaudit", "woorank", "aiaudit"]) assert.equal(done.parts[p].state, "skipped", p);
    assert.deepEqual(t.calls, { siteaudit: 0, woorank: 0, aiaudit: 0, semrush: 2 }, "client + 1 competitor exports, no audits");
    assert.deepEqual(postedNames(t), ["Yoga Peace - Domain Keyword Report.xlsx"], "the Gap file is left out");
  } finally {
    await t.cleanup();
  }
});

test("Pick reports: Gap only -- keyword data is fetched, but only the Gap file is posted", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], competitors: ["c1.com.au", "c2.com.au"], reports: ["gap"] });
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "done", JSON.stringify(done.parts));
    assert.equal(done.parts.keywords.state, "skipped");
    assert.match(done.parts.keywords.step, /used for the Gap report/);
    assert.deepEqual(postedNames(t), ["Yoga Peace - Gap & Competitor Analysis.xlsx"]);
    const report = await prisma.domainReport.findUniqueOrThrow({ where: { id: done.reportId } });
    assert.equal((report.files as unknown[]).length, 1, "the unpicked Keyword Analysis file isn't kept either");
  } finally {
    await t.cleanup();
  }
});

test("Pick reports: the three audits only -- no keyword tool needed, posted without a Keyword Analysis", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: [], reports: ["siteaudit", "woorank", "aiaudit"] });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const done = await t.waitBundle(started.body.id);
    assert.equal(done.state, "done", JSON.stringify(done.parts));
    assert.equal(t.calls.semrush, 0, "no keyword exports");
    assert.deepEqual(postedNames(t), ["Yoga Peace - Semrush Site Audit.pdf", "Yoga Peace - WooRank Audit.pdf", "Yoga Peace - AI SEO Audit.xlsx"]);
    assert.match(t.posted[0].lines[0], /^Hii @Farid Ansari sir/);
  } finally {
    await t.cleanup();
  }
});

test("Pick reports: the AI SEO Audit without both the Site Audit and WooRank is refused, saying why", async () => {
  const t = await setup();
  try {
    // Through the page's request (the shared rate limit allows only so many per test file)...
    const res = await t.api.post("/api/domain-intel/bundles").send({ clientId: t.client.id, sources: ["semrush"], reports: ["aiaudit"] });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /AI SEO Audit is written from the Site Audit and the WooRank audit -- tick both/);
    // ...and the other combinations straight against the run.
    const input = { client: { id: t.client.id, workspaceId: null, name: "Yoga Peace", domainReportTaskId: null }, websiteUrl: "https://yogapeace.com.au", location: null, sources: ["semrush" as const], competitors: [], reportMode: "combined" as const, createdBy: null };
    const deps = { fetchers: { semrush: async () => ({ buffer: Buffer.from(""), fileName: "x.csv" }) }, auditFetchers: { siteaudit: async () => ({ buffer: Buffer.from(""), fileName: "x.pdf" }), woorank: async () => ({ buffer: Buffer.from(""), fileName: "x.pdf" }) }, postComment: async () => {} };
    for (const reports of [["aiaudit", "siteaudit"], ["keywords", "aiaudit", "woorank"]] as BundleReport[][]) {
      assert.throws(() => startBundle({ ...input, reports }, deps), /tick both of them too/, JSON.stringify(reports));
    }
    assert.throws(() => startBundle({ ...input, reports: [] }, deps), /Tick at least one report/);
  } finally {
    await t.cleanup();
  }
});