import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import type { Prisma } from "@prisma/client";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession } from "./helpers/auth.js";

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

async function makeNotification(workspaceId: string, overrides: Partial<Prisma.NotificationUncheckedCreateInput> = {}) {
  return prisma.notification.create({
    data: {
      workspaceId,
      type: "RUN_COMPLETED",
      message: "Run completed: Test Client — test.xlsx",
      ...overrides,
    },
  });
}

test("GET /api/notifications: lists only this workspace's notifications, newest first, with an accurate unread count", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `other-${randomUUID()}`, name: "Other" } });
  try {
    const older = await makeNotification(auth.workspace.id, { message: "older" });
    await prisma.notification.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const alreadyRead = await makeNotification(auth.workspace.id, { message: "already read", read: true });
    const newest = await makeNotification(auth.workspace.id, { message: "newest" });
    await makeNotification(otherWorkspace.id, { message: "belongs to a different workspace" });

    const res = await request(app).get(`/api/notifications?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications.length, 3);
    assert.equal(res.body.notifications[0].id, newest.id, "newest first");
    assert.equal(res.body.unreadCount, 2, "the pre-marked-read one is excluded from the unread count");
    assert.equal(res.body.notifications.some((n: { message: string }) => n.message === "belongs to a different workspace"), false);
    assert.ok(res.body.notifications.find((n: { id: string }) => n.id === alreadyRead.id));
  } finally {
    await prisma.notification.deleteMany({ where: { workspaceId: { in: [auth.workspace.id, otherWorkspace.id] } } });
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("POST /api/notifications/mark-read: marks every unread notification in the workspace as read, without touching other workspaces", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `other-${randomUUID()}`, name: "Other" } });
  try {
    await makeNotification(auth.workspace.id);
    await makeNotification(auth.workspace.id);
    const otherUnread = await makeNotification(otherWorkspace.id);

    const res = await request(app)
      .post("/api/notifications/mark-read")
      .set("Cookie", auth.cookieHeader)
      .send({ workspaceId: auth.workspace.id });
    assert.equal(res.status, 200);

    const listRes = await request(app).get(`/api/notifications?workspaceId=${auth.workspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(listRes.body.unreadCount, 0);

    const untouched = await prisma.notification.findUnique({ where: { id: otherUnread.id } });
    assert.equal(untouched?.read, false, "a different workspace's unread notification must not be affected");
  } finally {
    await prisma.notification.deleteMany({ where: { workspaceId: { in: [auth.workspace.id, otherWorkspace.id] } } });
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("GET /api/notifications: a foreign workspaceId is rejected (403), not silently returning empty", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  const otherWorkspace = await prisma.workspace.create({ data: { slug: `other-${randomUUID()}`, name: "Other" } });
  try {
    const res = await request(app).get(`/api/notifications?workspaceId=${otherWorkspace.id}`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 403);
  } finally {
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    await auth.cleanup();
  }
});

test("GET /api/notifications requires authentication", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).get("/api/notifications?workspaceId=whatever");
  assert.equal(res.status, 401);
});

test.after(async () => {
  await prisma.$disconnect();
});
