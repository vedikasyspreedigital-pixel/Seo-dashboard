import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { createMockCommentPoster } from "../backend/domainIntel/clickupCommentPoster.js";
import { postDomainReport } from "../backend/domainIntel/createDomainReport.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Audit 2026-10-27: in test mode a "send" is marked SENT / "Posted" exactly like real delivery. The page
// now asks the server what it really does (banner), and a mock-posted Domain Intel report says so.

const noCalls: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

test("GET /api/delivery-mode: signed-in only; says mock for the mock sender/poster, live for real ones", async () => {
  const auth = await createAuthenticatedSession();
  try {
    const mockApp = createApp(noCalls, "mock");
    assert.equal((await request(mockApp).get("/api/delivery-mode")).status, 401);
    const mock = await request(mockApp).get("/api/delivery-mode").set("Cookie", auth.cookieHeader);
    assert.deepEqual(mock.body, { dataForSeo: "mock", email: "mock", comments: "mock" });

    const liveApp = createApp(noCalls, "live", "https://api.dataforseo.com/x", { sendEmail: async () => ({ messageId: "real-1" }) }, { postComment: async () => {} });
    const live = await request(liveApp).get("/api/delivery-mode").set("Cookie", auth.cookieHeader);
    assert.deepEqual(live.body, { dataForSeo: "live", email: "live", comments: "live" });
  } finally {
    await auth.cleanup();
  }
});

test("postDomainReport: a test-mode post is marked mockPosted; a real post isn't", async () => {
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: "Delivery Mode Test", workspaceId: auth.workspace.id, domainReportTaskId: "86dmode1" } });
  const make = () =>
    prisma.domainReport.create({
      data: { clientId: client.id, websiteUrl: "mode.test", sources: ["semrush"], reportMode: "combined", summary: { sources: {} }, files: [], status: "GENERATED" },
    });
  try {
    const mocked = await make();
    await postDomainReport(mocked.id, createMockCommentPoster());
    const mockedRow = await prisma.domainReport.findUniqueOrThrow({ where: { id: mocked.id } });
    assert.equal(mockedRow.status, "POSTED");
    assert.equal((mockedRow.summary as { mockPosted?: boolean }).mockPosted, true);
    assert.deepEqual((mockedRow.summary as { sources?: object }).sources, {}, "the rest of the summary is kept");

    const real = await make();
    await postDomainReport(real.id, async () => {});
    const realRow = await prisma.domainReport.findUniqueOrThrow({ where: { id: real.id } });
    assert.equal(realRow.status, "POSTED");
    assert.equal((realRow.summary as { mockPosted?: boolean }).mockPosted, undefined);
  } finally {
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});
