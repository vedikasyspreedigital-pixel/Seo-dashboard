import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import request from "supertest";
import { createApp } from "../backend/api/app.js";
import { categorize } from "../backend/api/routes/storage.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { prisma } from "../backend/db/client.js";

// Settings > Storage (2026-10-16): how full the uploads disk is and what uses it.

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});
const unused: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

test("categorize: report PDFs, extra PDFs, domain reports, uploaded Excels, debug snapshots", () => {
  const reports = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve("reports");
  const uploads = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve("uploads");
  assert.equal(categorize(path.join(reports, "abc.pdf")), "reportPdfs");
  assert.equal(categorize(path.join(reports, "extra", "r1", "x.pdf")), "extraPdfs");
  assert.equal(categorize(path.join(reports, "domain-intel", "d1", "x.xlsx")), "domainReports");
  assert.equal(categorize(path.join(uploads, "1700000000-AKT Automation Template.xlsx")), "uploadedExcels");
  assert.equal(categorize(path.join(uploads, "debug-failure-2026.png")), "debugSnapshots");
  assert.equal(categorize(path.join(uploads, "clickup-storage-state.json")), "other");
});

test("GET /api/storage: login required; returns disk size/free and app usage by category", async () => {
  const app = createApp(unused, "mock");
  assert.equal((await request(app).get("/api/storage")).status, 401);
  const res = await authedRequest(app, auth.cookieHeader).get("/api/storage");
  assert.equal(res.status, 200);
  for (const k of ["reportPdfs", "extraPdfs", "domainReports", "uploadedExcels", "debugSnapshots", "other"]) assert.equal(typeof res.body.usedByApp[k], "number");
  assert.equal(res.body.appTotalBytes, Object.values(res.body.usedByApp as Record<string, number>).reduce((a, b) => a + b, 0));
  if (res.body.disk) assert.ok(res.body.disk.totalBytes >= res.body.disk.freeBytes);
});
