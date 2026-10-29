import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { clearFetchJobs } from "../backend/domainIntel/fetchJob.js";
import { UNCLAIMED_TIMEOUT_MS, claimNext, completeTask, createAgentFetcher, expireStale, reportProgress, resetAgentQueue } from "../backend/domainIntel/agentQueue.js";
import { clearAuditJobs } from "../backend/domainIntel/auditJob.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// The office Chrome agent (extension/): the dashboard queues a fetch, the
// extension claims it with the shared token, reports progress (incl. "a person
// must tick verify-you-are-human"), and uploads the export -- which then
// finishes the fetch exactly like any other fetcher.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};
const TOKEN = "test-agent-token-0123456789";

function ahrefsExport(): Buffer {
  const text = ["Keyword\tVolume\tCurrent position", "yoga classes\t1200\t1", "hot yoga\t1100\t8"].join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

async function setup() {
  clearFetchJobs();
  resetAgentQueue();
  process.env.DOMAIN_INTEL_AGENT_TOKEN = TOKEN;
  const auth = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {},
    classifyWithAi: null,
    fetchers: { ahrefs: createAgentFetcher("ahrefs") },
  });
  const client = await prisma.client.create({ data: { name: "Yoga Peace", domain: "https://www.yogapeaceaustralia.com", workspaceId: auth.workspace.id } });
  const api = authedRequest(app, auth.cookieHeader);
  const agent = (method: "get" | "post", path: string) => request(app)[method](`/api/agent${path}`).set("Authorization", `Bearer ${TOKEN}`);
  const job = async (id: string) => (await api.get(`/api/domain-intel/fetches/${id}`)).body;
  const cleanup = async () => {
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
    clearFetchJobs();
    resetAgentQueue();
    delete process.env.DOMAIN_INTEL_AGENT_TOKEN;
  };
  return { app, api, client, agent, job, cleanup };
}

test("agent API: off (404) without DOMAIN_INTEL_AGENT_TOKEN; 401 with a wrong token; 204 when there is no work", async () => {
  const t = await setup();
  try {
    assert.equal((await request(t.app).get("/api/agent/tasks/next").set("Authorization", "Bearer nope")).status, 401);
    assert.equal((await request(t.app).get("/api/agent/tasks/next")).status, 401);
    assert.equal((await t.agent("get", "/tasks/next")).status, 204);
    delete process.env.DOMAIN_INTEL_AGENT_TOKEN;
    assert.equal((await t.agent("get", "/tasks/next")).status, 404);
  } finally {
    await t.cleanup();
  }
});

test("dashboard fetch -> extension claims it, reports steps (incl. waiting for a person), uploads the CSV -> attached", async () => {
  const t = await setup();
  try {
    const started = await t.api.post("/api/domain-intel/fetches").send({ source: "ahrefs", clientId: t.client.id, location: "au" });
    assert.equal(started.status, 202);

    const claimed = await t.agent("get", "/tasks/next?version=0.1.0");
    assert.equal(claimed.status, 200);
    assert.deepEqual({ tool: claimed.body.tool, domain: claimed.body.domain, location: claimed.body.location }, { tool: "ahrefs", domain: "yogapeaceaustralia.com", location: "au" });
    assert.equal(Object.keys(claimed.body).sort().join(","), "domain,id,location,tool", "the extension gets no client data");
    assert.equal((await t.agent("get", "/tasks/next")).status, 204, "a claimed task is not handed out twice");

    await t.agent("post", `/tasks/${claimed.body.id}/progress`).send({ step: "Opening Flikover", needsHuman: true });
    assert.match((await t.job(started.body.id)).step, /verify you are human/);
    // Extension 0.1.2: a signed-out tool waits for a person to sign in -- said as that, not as a captcha.
    await t.agent("post", `/tasks/${claimed.body.id}/progress`).send({ step: "Sign in to seotooladda in the window that just opened", needsHuman: true });
    const waiting = (await t.job(started.body.id)).step;
    assert.match(waiting, /Waiting for a person on the office computer: Sign in to seotooladda/);
    assert.doesNotMatch(waiting, /verify you are human/);
    await t.agent("post", `/tasks/${claimed.body.id}/progress`).send({ step: "Exporting 2 keywords" });
    assert.equal((await t.job(started.body.id)).step, "Exporting 2 keywords");

    const done = await t.agent("post", `/tasks/${claimed.body.id}/result`).attach("file", ahrefsExport(), "yogapeace-organic-keywords.csv");
    assert.equal(done.status, 200);
    let job = await t.job(started.body.id);
    for (let i = 0; i < 50 && job.state !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = await t.job(started.body.id);
    }
    assert.equal(job.state, "done");
    assert.equal(job.keywords, 2);
    assert.equal(job.fileName, "yogapeace-organic-keywords.csv");
    assert.equal((await t.agent("post", `/tasks/${claimed.body.id}/result`).attach("file", ahrefsExport(), "x.csv")).status, 410, "a finished task can't be completed twice");
  } finally {
    await t.cleanup();
  }
});

test("Semrush Site Audit PDF: queued for the agent, PDF uploaded -> downloadable; a non-PDF is refused", async () => {
  clearFetchJobs();
  resetAgentQueue();
  clearAuditJobs();
  process.env.DOMAIN_INTEL_AGENT_TOKEN = TOKEN;
  const auth = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {},
    classifyWithAi: null,
    auditFetchers: { siteaudit: createAgentFetcher("siteaudit") },
    // Stands in for Gemini: records what it was given, returns a PDF.
    aiAuditWriter: async (input) => {
      aiCalls.push({ clientName: input.clientName, sources: input.sources.map((s) => `${s.label}:${s.buffer.subarray(0, 4).toString("latin1")}`) });
      return { buffer: Buffer.from("%PDF-1.4 ai audit"), fileName: "yogapeaceaustralia.com-ai-seo-audit.pdf" };
    },
  });
  const aiCalls: { clientName: string; sources: string[] }[] = [];
  const client = await prisma.client.create({ data: { name: "Yoga Peace", domain: "https://www.yogapeaceaustralia.com", workspaceId: auth.workspace.id } });
  const api = authedRequest(app, auth.cookieHeader);
  const agent = (method: "get" | "post", p: string) => request(app)[method](`/api/agent${p}`).set("Authorization", `Bearer ${TOKEN}`);
  const waitDone = async (id: string) => {
    let job = (await api.get(`/api/domain-intel/audits/${id}`)).body;
    for (let i = 0; i < 50 && (job.state === "queued" || job.state === "running"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await api.get(`/api/domain-intel/audits/${id}`)).body;
    }
    return job;
  };
  try {
    assert.equal((await api.post("/api/domain-intel/audits").send({ kind: "woorank", clientId: client.id })).status, 422, "WooRank isn't available on this server (no agent fetcher)");
    const tooEarly = await api.post("/api/domain-intel/audits").send({ kind: "aiaudit", clientId: client.id });
    assert.equal(tooEarly.status, 422, "the AI audit needs a finished Site Audit to read");
    assert.match(tooEarly.body.error, /WooRank audit \(and the Semrush Site Audit\) first/);

    const started = await api.post("/api/domain-intel/audits").send({ kind: "siteaudit", clientId: client.id });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const task = await agent("get", "/tasks/next");
    assert.equal(task.body.tool, "siteaudit");
    assert.equal(task.body.domain, "yogapeaceaustralia.com");
    await agent("post", `/tasks/${task.body.id}/progress`).send({ step: "Semrush is crawling the site (54/1,000 pages) -- 3 min so far" });
    assert.match((await api.get(`/api/domain-intel/audits/${started.body.id}`)).body.step, /crawling/);
    assert.equal((await api.get(`/api/domain-intel/audits/${started.body.id}/file`)).status, 409, "not ready yet");

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    await agent("post", `/tasks/${task.body.id}/result`).attach("file", pdf, "yogapeaceaustralia.com-semrush-site-audit-full.pdf");
    const done = await waitDone(started.body.id);
    assert.equal(done.state, "done");
    assert.equal(done.filePath, undefined, "server paths never reach the browser");
    const file = await api.get(`/api/domain-intel/audits/${started.body.id}/file`).buffer(true);
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "application/pdf");

    // AI SEO Audit: made on the server from the finished Site Audit PDF.
    const ai = await api.post("/api/domain-intel/audits").send({ kind: "aiaudit", clientId: client.id });
    assert.equal(ai.status, 202, JSON.stringify(ai.body));
    const aiDone = await waitDone(ai.body.id);
    assert.equal(aiDone.state, "done", JSON.stringify(aiDone));
    assert.equal(aiDone.fileName, "yogapeaceaustralia.com-ai-seo-audit.pdf");
    assert.deepEqual(aiCalls, [{ clientName: "Yoga Peace", sources: ["Semrush Site Audit:%PDF"] }]);
    assert.equal((await agent("get", "/tasks/next")).status, 204, "the AI audit never goes to the Chrome agent");

    const second = await api.post("/api/domain-intel/audits").send({ kind: "siteaudit", clientId: client.id });
    const task2 = await agent("get", "/tasks/next");
    await agent("post", `/tasks/${task2.body.id}/result`).attach("file", Buffer.from("<html>error</html>"), "x.pdf");
    const failed = await waitDone(second.body.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /isn't a PDF/);
  } finally {
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
    resetAgentQueue();
    clearAuditJobs();
    delete process.env.DOMAIN_INTEL_AGENT_TOKEN;
  }
});

test("agent failures: a reported failure (e.g. signed out) and an agent that never picks the job up both fail the fetch with a reason", async () => {
  const t = await setup();
  try {
    const first = await t.api.post("/api/domain-intel/fetches").send({ source: "ahrefs", clientId: t.client.id });
    const claimed = await t.agent("get", "/tasks/next");
    await t.agent("post", `/tasks/${claimed.body.id}/fail`).send({ code: "SESSION_EXPIRED", message: "Flikover is signed out in the office Chrome." });
    await new Promise((r) => setTimeout(r, 50));
    const failed = await t.job(first.body.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.code, "SESSION_EXPIRED");

    const second = await t.api.post("/api/domain-intel/fetches").send({ source: "ahrefs", clientId: t.client.id });
    expireStale(Date.now() + UNCLAIMED_TIMEOUT_MS + 1000);
    await new Promise((r) => setTimeout(r, 50));
    const offline = await t.job(second.body.id);
    assert.equal(offline.state, "failed");
    assert.equal(offline.code, "AGENT_OFFLINE");
    assert.match(offline.error, /office Chrome agent didn't pick up the job/);
  } finally {
    await t.cleanup();
  }
});

test("a job queued behind a long one waits while the agent works -- it's not 'didn't pick up the job'", async () => {
  resetAgentQueue();
  const outcomes: string[] = [];
  const track = (p: Promise<unknown>, name: string) => p.then(() => outcomes.push(`${name}: done`), (e: Error) => outcomes.push(`${name}: ${e.message}`));
  try {
    // A run queues the Site Audit and WooRank at once; the agent takes the Site Audit (8-10 minutes).
    track(createAgentFetcher("siteaudit")({ domain: "fence.com.au", location: "au" }), "siteaudit");
    await new Promise((r) => setTimeout(r, 5));
    track(createAgentFetcher("woorank")({ domain: "fence.com.au", location: "au" }), "woorank");
    const site = claimNext("test")!;
    assert.equal(site.tool, "siteaudit");

    // 3 minutes in, still crawling: WooRank keeps waiting.
    reportProgress(site.id, "Crawling 120/1000");
    expireStale(Date.now() + 3 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(outcomes, []);

    // The Site Audit finishes; the agent asks for the next job and gets WooRank.
    completeTask(site.id, { buffer: Buffer.from("%PDF-1.4"), fileName: "site.pdf" });
    const next = claimNext("test")!;
    assert.equal(next.tool, "woorank");
    completeTask(next.id, { buffer: Buffer.from("%PDF-1.4"), fileName: "woorank.pdf" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(outcomes.sort(), ["siteaudit: done", "woorank: done"]);

    // With the agent really gone (nothing for over 2 minutes and nothing being worked on), a job still fails.
    track(createAgentFetcher("woorank")({ domain: "other.com.au", location: "au" }), "offline");
    expireStale(Date.now() + UNCLAIMED_TIMEOUT_MS + 1000);
    await new Promise((r) => setTimeout(r, 10));
    assert.match((outcomes as string[]).find((o) => o.startsWith("offline"))!, /didn't pick up the job/);
  } finally {
    resetAgentQueue();
  }
});
