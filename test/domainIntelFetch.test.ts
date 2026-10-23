import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { readKeywordExport } from "../backend/domainIntel/readKeywordExport.js";
import { domainReportDir } from "../backend/domainIntel/createDomainReport.js";
import { brandTerms, classifyByPattern, classifyIntents, pickFromToolLabels } from "../backend/domainIntel/classifyIntent.js";
import { clearFetchJobs } from "../backend/domainIntel/fetchJob.js";
import { FetchError, ahrefsCountry, bareDomain, countCsvRows, runExclusive, type FetchExportFn } from "../backend/domainIntel/fetchers/flikoverAhrefs.js";
import type { PostCommentParams } from "../backend/domainIntel/clickupCommentPoster.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Domain Intelligence Phase 2, the user's flow: "Fetch from Ahrefs" runs in the
// background (fetcher faked here -- never Flikover) while Semrush/Ubersuggest
// are uploaded; the fetched file is then used by "Combine and post" like an
// upload. Nothing is combined or posted until that click.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};
const SEMRUSH_CSV = "Keyword,Position,Search Volume\nmeraki photography,1,480\nwedding photography melbourne,59,1900";

/** Ahrefs' real export shape: UTF-16, tabs, one true/false column per intent. */
function ahrefsExport(): Buffer {
  const text = [
    ["Keyword", "Branded", "Navigational", "Informational", "Commercial", "Transactional", "Volume", "Current position"],
    ["book photographer melbourne", "false", "false", "false", "true", "true", "320", "8"],
    ["photo studio", "false", "false", "true", "true", "false", "90", "12"],
    ["what is bokeh", "false", "false", "false", "false", "false", "50", "40"],
  ]
    .map((r) => r.map((c) => `"${c}"`).join("\t"))
    .join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

const goodFetcher: FetchExportFn = async ({ onStep }) => {
  onStep?.("Exporting CSV");
  return { buffer: ahrefsExport(), fileName: "x-organic-keywords.csv" };
};

async function setup(fetcher: FetchExportFn) {
  clearFetchJobs();
  const auth = await createAuthenticatedSession();
  const posted: PostCommentParams[] = [];
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async (p) => {
      posted.push(p);
    },
    classifyWithAi: null,
    fetchers: { ahrefs: fetcher },
    fetchInfo: async () => ({ live: false, sessionSaved: true }),
  });
  const client = await prisma.client.create({
    data: { name: "Meraki Photography", domain: "https://www.merakiphotography.com.au/", workspaceId: auth.workspace.id, domainReportTaskId: "86dfetch1" },
  });
  const api = authedRequest(app, auth.cookieHeader);
  const fetchAhrefs = () => api.post("/api/domain-intel/fetches").send({ source: "ahrefs", clientId: client.id, location: "au" });
  const waitJob = async (id: string) => {
    let job = (await api.get(`/api/domain-intel/fetches/${id}`)).body;
    for (let i = 0; i < 150 && (job.state === "queued" || job.state === "fetching"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await api.get(`/api/domain-intel/fetches/${id}`)).body;
    }
    return job;
  };
  const combine = (fetchId: string) =>
    api.post("/api/domain-intel/reports").field("clientId", client.id).field("location", "au").field("fetched_ahrefs", fetchId).attach("semrush", Buffer.from(SEMRUSH_CSV), "semrush.csv");
  const waitPosted = async (id: string) => {
    let report = await prisma.domainReport.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 150 && report.status !== "POSTED" && report.status !== "POST_FAILED"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      report = await prisma.domainReport.findUniqueOrThrow({ where: { id } });
    }
    return report;
  };
  const cleanup = async () => {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) await rm(domainReportDir(r.id), { recursive: true, force: true });
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
    clearFetchJobs();
  };
  return { api, auth, client, posted, fetchAhrefs, waitJob, combine, waitPosted, cleanup };
}

test("helpers: bare domain for Ahrefs, Semrush 'uk' is Ahrefs 'gb', export row count", () => {
  assert.equal(bareDomain("https://www.MerakiPhotography.com.au/weddings?x=1"), "merakiphotography.com.au");
  assert.equal(ahrefsCountry("uk"), "gb");
  assert.equal(ahrefsCountry("au"), "au");
  assert.equal(ahrefsCountry(null), "au");
  assert.equal(countCsvRows(ahrefsExport()), 3, "export completeness check counts data rows, not the header");
});

test("readKeywordExport: Ahrefs' true/false intent columns are read as tool labels (hints)", async () => {
  const e = await readKeywordExport("ahrefs", ahrefsExport(), "ahrefs.csv");
  assert.deepEqual(
    e.rows.map((r) => [r.keyword, r.sourceIntent]),
    [
      ["book photographer melbourne", "Commercial, Transactional"],
      ["photo studio", "Informational, Commercial"],
      ["what is bokeh", null],
    ],
  );
});

test("one intent without AI: Ahrefs' several labels -> the most specific one; none -> Informational (unresolved)", async () => {
  assert.equal(pickFromToolLabels(["Informational, Commercial, Transactional"]), "Transactional");
  assert.equal(pickFromToolLabels(["Informational, Navigational"]), "Navigational");
  assert.equal(pickFromToolLabels([]), null);
  const r = await classifyIntents(
    ["yoga peace", "hatha yoga", "bokeh"],
    { clientName: "Yoga Peace", websiteUrl: "yogapeaceaustralia.com" },
    null,
    new Map([["hatha yoga", ["Informational, Commercial"]]]),
  );
  assert.deepEqual([...r.intents], [["yoga peace", "Navigational"], ["hatha yoga", "Commercial"], ["bokeh", "Informational"]]);
  assert.deepEqual([r.byPattern, r.byToolLabels, r.unresolved], [1, 1, 1]);

  // Brand without the domain's extra words ("yoga peace" for yogapeaceaustralia.com) -- but never a generic single word.
  const brands = brandTerms("Local Test Client", "https://www.yogapeaceaustralia.com");
  assert.equal(classifyByPattern("yoga peace", brands), "Navigational");
  assert.equal(classifyByPattern("yoga", brands), null);
  assert.equal(classifyByPattern("yoga classes", brands), null);
});

test("runExclusive: two fetches never overlap (one robot on the shared account at a time)", async () => {
  let active = 0;
  let maxActive = 0;
  const job = () =>
    runExclusive(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
  await Promise.all([job(), job(), job()]);
  assert.equal(maxActive, 1);
});

test("Fetch from Ahrefs, upload Semrush meanwhile, then Combine and post: the fetched file is used like an upload", async () => {
  const seen: { domain: string; location: string | null }[] = [];
  const t = await setup(async (req) => {
    seen.push({ domain: req.domain, location: req.location });
    await new Promise((r) => setTimeout(r, 300)); // still running when the "double-click" arrives
    return goodFetcher(req);
  });
  try {
    const started = await t.fetchAhrefs();
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.ok(["queued", "fetching"].includes(started.body.state));
    assert.equal((await t.fetchAhrefs()).body.id, started.body.id, "a double-click never starts a second robot");

    const job = await t.waitJob(started.body.id);
    assert.equal(job.state, "done");
    assert.equal(job.keywords, 3);
    assert.equal(job.fileName, "x-organic-keywords.csv");
    assert.equal(job.filePath, undefined, "server paths never reach the browser");
    assert.deepEqual(seen, [{ domain: "merakiphotography.com.au", location: "au" }]);
    assert.equal(t.posted.length, 0, "fetching alone never posts");

    const res = await t.combine(job.id);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.sources, ["semrush", "ahrefs"]);
    assert.deepEqual(res.body.summary.sources, { semrush: { keywords: 2, duplicatesRemoved: 0 }, ahrefs: { keywords: 3, duplicatesRemoved: 0 } });
    assert.equal((await t.waitPosted(res.body.id)).status, "POSTED");
    assert.equal(t.posted.length, 1);
    assert.equal(t.posted[0].taskId, "86dfetch1");
  } finally {
    await t.cleanup();
  }
});

test("a failed fetch: shown with its reason, login problems raise the banner, combining with it is refused; fetching again works", async () => {
  let fail = true;
  const t = await setup(async (req) => {
    if (fail) throw new FetchError("SESSION_EXPIRED", "The saved Flikover login has expired. Sign in again.");
    return goodFetcher(req);
  });
  try {
    const job = await t.waitJob((await t.fetchAhrefs()).body.id);
    assert.equal(job.state, "failed");
    assert.equal(job.code, "SESSION_EXPIRED");
    assert.match(job.error, /expired/);
    assert.equal((await t.api.get("/api/domain-intel/fetch-status")).body.loginProblem.code, "SESSION_EXPIRED");

    const refused = await t.combine(job.id);
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /fetch failed -- fetch it again or upload/);
    assert.equal(t.posted.length, 0);

    fail = false;
    const again = await t.waitJob((await t.fetchAhrefs()).body.id);
    assert.notEqual(again.id, job.id);
    assert.equal(again.state, "done");
    assert.equal((await t.api.get("/api/domain-intel/fetch-status")).body.loginProblem, null, "the banner clears after a good fetch");
  } finally {
    await t.cleanup();
  }
});

test("fetch safety: only Ahrefs is fetchable; another client's fetch can't be used; another workspace can't see it", async () => {
  const t = await setup(goodFetcher);
  const other = await createAuthenticatedSession();
  const otherClient = await prisma.client.create({ data: { name: "Other Co", domain: "other.example", workspaceId: t.auth.workspace.id } });
  try {
    const semrush = await t.api.post("/api/domain-intel/fetches").send({ source: "semrush", clientId: t.client.id });
    assert.equal(semrush.status, 422);
    assert.match(semrush.body.error, /SEMrush can't be fetched automatically/);

    const job = await t.waitJob((await t.fetchAhrefs()).body.id);
    const wrongClient = await t.api.post("/api/domain-intel/reports").field("clientId", otherClient.id).field("fetched_ahrefs", job.id);
    assert.equal(wrongClient.status, 422, "a fetch only counts for the client it was made for");

    const foreign = await authedRequest(createApp(neverCalled, "mock"), other.cookieHeader).get(`/api/domain-intel/fetches/${job.id}`);
    assert.equal(foreign.status, 404);
  } finally {
    await prisma.client.delete({ where: { id: otherClient.id } });
    await other.cleanup();
    await t.cleanup();
  }
});
