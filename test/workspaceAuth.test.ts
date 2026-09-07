import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { hashPassword, verifyPassword } from "../backend/auth/password.js";
import { createSession, getUserForSession, SESSION_COOKIE_NAME } from "../backend/auth/session.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Local only: real Postgres (localhost:5433). No ranking/reporting/email
// code touched -- this is purely the new access/workspace layer.

const unusedDataForSeoMock: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

test("hashPassword/verifyPassword: round-trips correctly, rejects a wrong password, never stores the plaintext", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.ok(!hash.includes("correct horse battery staple"), "the plaintext must never appear in the stored hash");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("hashPassword: two hashes of the same password are different (random salt per call)", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-password", a), true);
  assert.equal(verifyPassword("same-password", b), true);
});

test("POST /api/auth/login: correct credentials succeed, set a session cookie, and return the user's workspaces", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const workspace = await prisma.workspace.create({ data: { slug: `login-test-${randomUUID()}`, name: "Login Test Workspace" } });
  const email = `login-test-${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("s3cret!"), name: "Test User", memberships: { create: { workspaceId: workspace.id } } },
  });
  try {
    const res = await request(app).post("/api/auth/login").send({ email, password: "s3cret!" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
    assert.deepEqual(res.body.workspaces, [{ id: workspace.id, slug: workspace.slug, name: workspace.name }]);

    const setCookie = [res.headers["set-cookie"]].flat();
    assert.ok(setCookie.length > 0, "login must set a cookie");
    assert.ok(setCookie.some((c) => c?.startsWith(`${SESSION_COOKIE_NAME}=`)));

    const sessionCount = await prisma.session.count({ where: { userId: user.id } });
    assert.equal(sessionCount, 1);
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }
});

test("POST /api/auth/login: wrong password and unknown email both return the same generic 401, never revealing which", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const email = `login-test-wrong-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: hashPassword("correct-password") } });
  try {
    const wrongPassword = await request(app).post("/api/auth/login").send({ email, password: "not-the-password" });
    const unknownEmail = await request(app).post("/api/auth/login").send({ email: `nobody-${randomUUID()}@example.com`, password: "anything" });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error, unknownEmail.body.error);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("POST /api/auth/login: an inactive user cannot log in even with the correct password", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const email = `login-test-inactive-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: hashPassword("s3cret!"), isActive: false } });
  try {
    const res = await request(app).post("/api/auth/login").send({ email, password: "s3cret!" });
    assert.equal(res.status, 401);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("POST /api/auth/login: requires both email and password", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const res = await request(app).post("/api/auth/login").send({ email: "someone@example.com" });
  assert.equal(res.status, 400);
});

test("GET /api/auth/me: returns the authenticated user + their workspaces, 401 without a session", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  try {
    const authed = await request(app).get("/api/auth/me").set("Cookie", auth.cookieHeader);
    assert.equal(authed.status, 200);
    assert.equal(authed.body.user.id, auth.user.id);
    assert.deepEqual(authed.body.workspaces, [auth.workspace]);

    const unauthed = await request(app).get("/api/auth/me");
    assert.equal(unauthed.status, 401);
  } finally {
    await auth.cleanup();
  }
});

test("POST /api/auth/logout: deletes the session server-side -- the same cookie no longer authenticates afterward", async () => {
  const app = createApp(unusedDataForSeoMock, "mock");
  const auth = await createAuthenticatedSession();
  try {
    const before = await request(app).get("/api/auth/me").set("Cookie", auth.cookieHeader);
    assert.equal(before.status, 200);

    const logoutRes = await request(app).post("/api/auth/logout").set("Cookie", auth.cookieHeader);
    assert.equal(logoutRes.status, 200);

    const after = await request(app).get("/api/auth/me").set("Cookie", auth.cookieHeader);
    assert.equal(after.status, 401, "the session must be dead server-side, not just cleared client-side");
  } finally {
    await auth.cleanup();
  }
});

test("getUserForSession: an expired session is treated as unauthenticated and is deleted on lookup", async () => {
  const user = await prisma.user.create({ data: { email: `expiry-test-${randomUUID()}@example.com`, passwordHash: hashPassword("x") } });
  try {
    const session = await createSession(user.id);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const resolved = await getUserForSession(session.id);
    assert.equal(resolved, null);

    const stillExists = await prisma.session.findUnique({ where: { id: session.id } });
    assert.equal(stillExists, null, "an expired session should be cleaned up on lookup, not left dangling");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("getUserForSession: an unknown session id resolves to null without throwing", async () => {
  const resolved = await getUserForSession(randomUUID());
  assert.equal(resolved, null);
});

test.after(async () => {
  await prisma.$disconnect();
});
