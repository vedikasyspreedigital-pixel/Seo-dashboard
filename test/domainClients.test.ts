import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { ProspectClientError, toClickUpTaskId } from "../backend/domainIntel/prospectClient.js";
import { clearFetchJobs } from "../backend/domainIntel/fetchJob.js";
import { clearAuditJobs } from "../backend/domainIntel/auditJob.js";
import { clearBundles } from "../backend/domainIntel/bundleJob.js";
import type { FetchExportFn } from "../backend/domainIntel/fetchers/flikoverAhrefs.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// 2026-10-28: Domain Intelligence is run for a new client almost every time, so the page types the client
// (name, website, ClickUp task) instead of picking one. Behind it: one hidden "domain" client per name.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};

test("ClickUp task: a bare ID or a task link is accepted, anything else is refused", () => {
  assert.equal(toClickUpTaskId(""), null);
  assert.equal(toClickUpTaskId("  86c1abcde "), "86c1abcde");
  assert.equal(toClickUpTaskId("#86c1abcde"), "86c1abcde");
  assert.equal(toClickUpTaskId("https://app.clickup.com/t/86c1abcde"), "86c1abcde");
  assert.equal(toClickUpTaskId("https://app.clickup.com/t/9016123456/SEO-123"), "SEO-123");
  assert.equal(toClickUpTaskId("https://app.clickup.com/t/86c1abcde?comment=1"), "86c1abcde");
  for (const bad of ["https://evil.example/t/86c1abcde", "https://app.clickup.com/9016/v/li/123", "not a task id!", "ab"]) {
    assert.throws(() => toClickUpTaskId(bad), ProspectClientError, bad);
  }
});

test("Typed client: made once per name (any case), reused with the new website/task, hidden from the ranking lists", async () => {
  const auth = await createAuthenticatedSession();
  const other = await createAuthenticatedSession();
  const api = authedRequest(createApp(neverCalled, "mock", undefined, undefined, { postComment: async () => {}, classifyWithAi: null }), auth.cookieHeader);
  try {
    const first = await api.post("/api/domain-intel/clients").send({ workspaceId: auth.workspace.id, name: "  Sell Car  For Cash ", websiteUrl: "https://sellcarforcash.com.au/", clickupTask: "https://app.clickup.com/t/86c1abcde" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.name, "Sell Car For Cash");
    assert.equal(first.body.domainReportTaskId, "86c1abcde");

    const again = await api.post("/api/domain-intel/clients").send({ workspaceId: auth.workspace.id, name: "sell car for cash", websiteUrl: "sellcarforcash.com.au", clickupTask: "" });
    assert.equal(again.body.id, first.body.id, "the same name reuses the client");
    assert.equal(again.body.domainReportTaskId, null, "an empty task = download only");

    const row = await prisma.client.findUniqueOrThrow({ where: { id: first.body.id } });
    assert.equal(row.kind, "domain");
    assert.equal(row.workspaceId, auth.workspace.id);

    // Not in the header's dropdown, nor in Client Management.
    for (const query of ["", "&includeInactive=true", "&includeInactive=true&includeArchived=true"]) {
      const list = await api.get(`/api/clients?workspaceId=${auth.workspace.id}${query}`);
      assert.equal(list.status, 200);
      assert.ok(!list.body.some((c: { id: string }) => c.id === first.body.id), `hidden from /clients${query}`);
    }

    const badTask = await api.post("/api/domain-intel/clients").send({ workspaceId: auth.workspace.id, name: "X", websiteUrl: "x.com", clickupTask: "https://evil.example/t/1234" });
    assert.equal(badTask.status, 400);
    const noName = await api.post("/api/domain-intel/clients").send({ workspaceId: auth.workspace.id, name: "  ", websiteUrl: "x.com", clickupTask: "" });
    assert.equal(noName.status, 400);
    const foreign = await api.post("/api/domain-intel/clients").send({ workspaceId: other.workspace.id, name: "X", websiteUrl: "x.com", clickupTask: "" });
    assert.equal(foreign.status, 403);
  } finally {
    await prisma.client.deleteMany({ where: { workspaceId: { in: [auth.workspace.id, other.workspace.id] } } });
    await auth.cleanup();
    await other.cleanup();
  }
});

test("History: every Domain Intelligence report of the workspace with its client's name -- never another workspace's", async () => {
  const auth = await createAuthenticatedSession();
  const other = await createAuthenticatedSession();
  const api = authedRequest(createApp(neverCalled, "mock", undefined, undefined, { postComment: async () => {}, classifyWithAi: null }), auth.cookieHeader);
  const report = (clientId: string, websiteUrl: string) =>
    prisma.domainReport.create({ data: { clientId, websiteUrl, sources: [], reportMode: "combined", summary: {}, files: [], status: "NOT_POSTED" } });
  try {
    const a = await prisma.client.create({ data: { name: "Alpha Plumbing", workspaceId: auth.workspace.id, kind: "domain", domainReportTaskId: "86alpha01" } });
    const b = await prisma.client.create({ data: { name: "Ranking Client", workspaceId: auth.workspace.id } });
    const foreign = await prisma.client.create({ data: { name: "Foreign", workspaceId: other.workspace.id, kind: "domain" } });
    await report(a.id, "https://alpha.com.au");
    await report(b.id, "https://ranking.com.au");
    await report(foreign.id, "https://foreign.com.au");

    const res = await api.get(`/api/domain-intel/history?workspaceId=${auth.workspace.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: { clientName: string }) => r.clientName).sort(), ["Alpha Plumbing", "Ranking Client"]);
    assert.equal(res.body.find((r: { clientName: string }) => r.clientName === "Alpha Plumbing").clientTaskId, "86alpha01");
    assert.ok(res.body.every((r: { files: { path?: string }[] }) => r.files.every((f) => !f.path)), "no server paths");

    assert.equal((await api.get(`/api/domain-intel/history?workspaceId=${other.workspace.id}`)).status, 403);
    assert.equal((await api.get("/api/domain-intel/history")).status, 400);
  } finally {
    await prisma.domainReport.deleteMany({ where: { client: { workspaceId: { in: [auth.workspace.id, other.workspace.id] } } } });
    await prisma.client.deleteMany({ where: { workspaceId: { in: [auth.workspace.id, other.workspace.id] } } });
    await auth.cleanup();
    await other.cleanup();
  }
});

test("Coming back to the page: my running run comes back with its client, website, country and task -- not someone else's", async () => {
  clearFetchJobs();
  clearAuditJobs();
  clearBundles();
  const auth = await createAuthenticatedSession();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const siteaudit: FetchExportFn = async () => {
    await hold; // keeps the run "running" while the test looks
    return { buffer: Buffer.from("%PDF-1.4 site"), fileName: "site.pdf" };
  };
  const app = createApp(neverCalled, "mock", undefined, undefined, { postComment: async () => {}, classifyWithAi: null, auditFetchers: { siteaudit }, bundlePollMs: 10 });
  const api = authedRequest(app, auth.cookieHeader);
  // A teammate in the same workspace.
  const teammate = await prisma.user.create({ data: { email: `teammate-${Date.now()}@example.com`, passwordHash: "x", memberships: { create: { workspaceId: auth.workspace.id } } } });
  const { createSession, SESSION_COOKIE_NAME } = await import("../backend/auth/session.js");
  const teammateApi = authedRequest(app, `${SESSION_COOKIE_NAME}=${(await createSession(teammate.id)).id}`);
  try {
    assert.equal((await api.get(`/api/domain-intel/bundles/mine?workspaceId=${auth.workspace.id}`)).body, null);

    const client = (await api.post("/api/domain-intel/clients").send({ workspaceId: auth.workspace.id, name: "Bright Dental", websiteUrl: "https://brightdental.com.au", clickupTask: "86bright1" })).body;
    const started = await api.post("/api/domain-intel/bundles").send({ clientId: client.id, websiteUrl: "https://brightdental.com.au", location: "nz", sources: [], reports: ["siteaudit"] });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const mine = (await api.get(`/api/domain-intel/bundles/mine?workspaceId=${auth.workspace.id}`)).body;
    assert.equal(mine.id, started.body.id);
    assert.equal(mine.clientName, "Bright Dental");
    assert.equal(mine.websiteUrl, "https://brightdental.com.au");
    assert.equal(mine.location, "nz");
    assert.equal(mine.clickupTaskId, "86bright1");
    assert.equal(mine.state, "running");

    assert.equal((await teammateApi.get(`/api/domain-intel/bundles/mine?workspaceId=${auth.workspace.id}`)).body, null, "a teammate's page isn't taken over by my run");
  } finally {
    release();
    await new Promise((r) => setTimeout(r, 100));
    await prisma.domainReport.deleteMany({ where: { client: { workspaceId: auth.workspace.id } } });
    await prisma.client.deleteMany({ where: { workspaceId: auth.workspace.id } });
    await prisma.session.deleteMany({ where: { userId: teammate.id } });
    await prisma.workspaceMembership.deleteMany({ where: { userId: teammate.id } });
    await prisma.user.delete({ where: { id: teammate.id } });
    await auth.cleanup();
    clearFetchJobs();
    clearAuditJobs();
    clearBundles();
  }
});
