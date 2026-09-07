import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// GET /api/clients workspace-scoping -- the load-bearing route for the
// whole workspace layer. Each test creates its own isolated workspace so
// results are exact, not "at least N" (no cross-test pollution possible).

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function cleanupClient(clientId: string) {
  await prisma.client.delete({ where: { id: clientId } });
}

test("GET /api/clients: only returns clients belonging to the requested workspace", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const authA = await createAuthenticatedSession();
  const authB = await createAuthenticatedSession();
  const clientA = await prisma.client.create({ data: { name: `Workspace A Client ${randomUUID()}`, workspaceId: authA.workspace.id } });
  const clientB = await prisma.client.create({ data: { name: `Workspace B Client ${randomUUID()}`, workspaceId: authB.workspace.id } });
  try {
    const resA = await request(app).get(`/api/clients?workspaceId=${authA.workspace.id}`).set("Cookie", authA.cookieHeader);
    assert.equal(resA.status, 200);
    assert.deepEqual(resA.body.map((c: { id: string }) => c.id), [clientA.id]);

    const resB = await request(app).get(`/api/clients?workspaceId=${authB.workspace.id}`).set("Cookie", authB.cookieHeader);
    assert.equal(resB.status, 200);
    assert.deepEqual(resB.body.map((c: { id: string }) => c.id), [clientB.id]);
  } finally {
    await cleanupClient(clientA.id);
    await cleanupClient(clientB.id);
    await authA.cleanup();
    await authB.cleanup();
  }
});

test("GET /api/clients: a user cannot list a workspace they have no membership for, even if it exists", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `no-access-${randomUUID()}`, name: "No Access Workspace" } });
  try {
    const res = await request(app).get(`/api/clients?workspaceId=${otherWorkspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 403);
  } finally {
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("GET /api/clients: excludes isTestData clients from the workspace list even if assigned to it", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const realClient = await prisma.client.create({ data: { name: `Real Client ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const testClient = await prisma.client.create({ data: { name: `API Test ${randomUUID()}`, workspaceId: auth.workspace.id, isTestData: true } });
  try {
    const res = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    const ids = res.body.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(realClient.id));
    assert.ok(!ids.includes(testClient.id), "isTestData clients must never appear in a workspace's client list");
  } finally {
    await cleanupClient(realClient.id);
    await cleanupClient(testClient.id);
    await auth.cleanup();
  }
});

test("GET /api/clients: excludes untriaged clients (workspaceId still null) from every workspace", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const untriaged = await prisma.client.create({ data: { name: `Untriaged Legacy Client ${randomUUID()}` } });
  try {
    const res = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((c: { id: string }) => c.id === untriaged.id));
  } finally {
    await cleanupClient(untriaged.id);
    await auth.cleanup();
  }
});

test("GET /api/clients: requires a workspaceId query parameter", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  try {
    const res = await request(app).get("/api/clients").set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 400);
  } finally {
    await auth.cleanup();
  }
});

test("GET /api/clients: an admin-style user with two workspace memberships can list either one", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const authPrimary = await createAuthenticatedSession();
  const secondWorkspace = await prisma.workspace.create({ data: { slug: `second-${randomUUID()}`, name: "Second Workspace" } });
  await prisma.workspaceMembership.create({ data: { userId: authPrimary.user.id, workspaceId: secondWorkspace.id } });
  const clientInSecond = await prisma.client.create({ data: { name: `Second Workspace Client ${randomUUID()}`, workspaceId: secondWorkspace.id } });
  try {
    const meRes = await request(app).get("/api/auth/me").set("Cookie", authPrimary.cookieHeader);
    assert.equal(meRes.body.workspaces.length, 2, "the user should now see both workspaces from GET /me");

    const res = await request(app).get(`/api/clients?workspaceId=${secondWorkspace.id}`).set("Cookie", authPrimary.cookieHeader);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((c: { id: string }) => c.id), [clientInSecond.id]);
  } finally {
    await cleanupClient(clientInSecond.id);
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: secondWorkspace.id } });
    await prisma.workspace.delete({ where: { id: secondWorkspace.id } });
    await authPrimary.cleanup();
  }
});

// Client Management CRUD -- create/edit/activate/deactivate/archive/restore,
// plus cross-workspace ownership checks on the new :id-scoped routes.

test("POST /api/clients: creates a client in the caller's workspace, with a ClientReportConfig when ClickUp fields are given", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  try {
    const res = await request(app)
      .post("/api/clients")
      .set("Cookie", auth.cookieHeader)
      .send({ workspaceId: auth.workspace.id, name: `New Client ${randomUUID()}`, clickupTaskId: "abc123", notes: "VIP" });
    assert.equal(res.status, 201);
    assert.equal(res.body.workspaceId, auth.workspace.id);
    assert.equal(res.body.notes, "VIP");
    assert.equal(res.body.clickupTaskId, "abc123");
    assert.equal(res.body.clickupTaskUrl, null);

    const config = await prisma.clientReportConfig.findFirst({ where: { clientId: res.body.id } });
    assert.ok(config, "a ClientReportConfig should have been created alongside the client");
    assert.equal(config!.clickupTaskId, "abc123");
  } finally {
    await prisma.clientReportConfig.deleteMany({ where: { client: { name: { startsWith: "New Client" } } } });
    await prisma.client.deleteMany({ where: { name: { startsWith: "New Client" } } });
    await auth.cleanup();
  }
});

test("POST /api/clients: rejects a workspace the caller has no membership for", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `no-access-${randomUUID()}`, name: "No Access Workspace" } });
  try {
    const res = await request(app)
      .post("/api/clients")
      .set("Cookie", auth.cookieHeader)
      .send({ workspaceId: otherWorkspace.id, name: "Should not be created" });
    assert.equal(res.status, 403);
  } finally {
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("POST /api/clients: rejects an empty name", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  try {
    const res = await request(app).post("/api/clients").set("Cookie", auth.cookieHeader).send({ workspaceId: auth.workspace.id, name: "  " });
    assert.equal(res.status, 400);
  } finally {
    await auth.cleanup();
  }
});

test("PATCH /api/clients/:id: updates name/notes and upserts the ClickUp mapping onto the client's ClientReportConfig", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Edit Me ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const res = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set("Cookie", auth.cookieHeader)
      .send({ name: "Renamed Client", notes: "internal note", clickupTaskUrl: "https://app.clickup.com/t/xyz" });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Renamed Client");
    assert.equal(res.body.notes, "internal note");
    assert.equal(res.body.clickupTaskUrl, "https://app.clickup.com/t/xyz");

    const config = await prisma.clientReportConfig.findFirst({ where: { clientId: client.id } });
    assert.equal(config!.clickupTaskUrl, "https://app.clickup.com/t/xyz");
  } finally {
    await prisma.clientReportConfig.deleteMany({ where: { clientId: client.id } });
    await cleanupClient(client.id);
    await auth.cleanup();
  }
});

test("PATCH /api/clients/:id: 404s for a client in a workspace the caller doesn't belong to", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const authA = await createAuthenticatedSession();
  const authB = await createAuthenticatedSession();
  const clientB = await prisma.client.create({ data: { name: `Workspace B Client ${randomUUID()}`, workspaceId: authB.workspace.id } });
  try {
    const res = await request(app).patch(`/api/clients/${clientB.id}`).set("Cookie", authA.cookieHeader).send({ name: "Hijacked" });
    assert.equal(res.status, 404);
  } finally {
    await cleanupClient(clientB.id);
    await authA.cleanup();
    await authB.cleanup();
  }
});

test("PATCH /api/clients/:id/deactivate then /activate: toggles isActive and is reflected in the dropdown-backing list", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Toggle Me ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const deactivateRes = await request(app).patch(`/api/clients/${client.id}/deactivate`).set("Cookie", auth.cookieHeader);
    assert.equal(deactivateRes.status, 200);
    assert.equal(deactivateRes.body.isActive, false);

    const listRes = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.ok(!listRes.body.some((c: { id: string }) => c.id === client.id), "a deactivated client must not appear in the plain (dropdown) client list");

    const activateRes = await request(app).patch(`/api/clients/${client.id}/activate`).set("Cookie", auth.cookieHeader);
    assert.equal(activateRes.status, 200);
    assert.equal(activateRes.body.isActive, true);
  } finally {
    await cleanupClient(client.id);
    await auth.cleanup();
  }
});

test("PATCH /api/clients/:id/archive then /restore: archiving also deactivates and hides from the management list by default; restoring un-hides but leaves it inactive", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Archive Me ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const archiveRes = await request(app).patch(`/api/clients/${client.id}/archive`).set("Cookie", auth.cookieHeader);
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.body.isActive, false);
    assert.ok(archiveRes.body.archivedAt, "archivedAt should be set");

    const managementListRes = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}&includeInactive=true`).set("Cookie", auth.cookieHeader);
    assert.ok(!managementListRes.body.some((c: { id: string }) => c.id === client.id), "an archived client must not appear in the management list by default");

    const withArchivedRes = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}&includeInactive=true&includeArchived=true`).set("Cookie", auth.cookieHeader);
    assert.ok(withArchivedRes.body.some((c: { id: string }) => c.id === client.id), "includeArchived=true should surface the archived client");

    const restoreRes = await request(app).patch(`/api/clients/${client.id}/restore`).set("Cookie", auth.cookieHeader);
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.body.archivedAt, null);
    assert.equal(restoreRes.body.isActive, false, "restoring must not silently re-activate the client");

    const afterRestoreRes = await request(app).get(`/api/clients?workspaceId=${auth.workspace.id}&includeInactive=true`).set("Cookie", auth.cookieHeader);
    assert.ok(afterRestoreRes.body.some((c: { id: string }) => c.id === client.id), "a restored (but still inactive) client should reappear in the management list");
  } finally {
    await cleanupClient(client.id);
    await auth.cleanup();
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
