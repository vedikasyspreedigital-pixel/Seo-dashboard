import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../backend/api/app.js";
import { hideServerPaths } from "../backend/api/hideServerPaths.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { COLUMN_HEADERS } from "../backend/excel/parser.js";

// Audit 2026-10-27 (#14): writes only from the dashboard, the real client address behind Railway's proxy,
// and no server folder paths in API responses.

const noCalls: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });

test("writes from another website are refused; the dashboard, scripts, reads and the Chrome agent are not", async () => {
  const app = createApp(noCalls, "mock");
  const refused = await request(app).post("/api/auth/login").set("Origin", "https://evil.example").send({ email: "a@b.c", password: "x" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /didn't come from the dashboard/);

  for (const origin of ["http://localhost:5173", "http://localhost:5174", undefined]) {
    const req = request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "x" });
    const res = origin ? await req.set("Origin", origin) : await req;
    assert.notEqual(res.status, 403, `origin ${origin}`);
  }
  assert.notEqual((await request(app).get("/api/health").set("Origin", "https://evil.example")).status, 403, "reads aren't blocked");
  assert.notEqual((await request(app).post("/api/agent/tasks/x/fail").set("Origin", "chrome-extension://abc").send({})).status, 403, "the office Chrome agent has its own token");
});

test("in production, a localhost origin is refused too", async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const app = createApp(noCalls, "mock");
    assert.equal((await request(app).post("/api/auth/logout").set("Origin", "http://localhost:5174")).status, 403);
  } finally {
    process.env.NODE_ENV = before;
  }
});

test("the app trusts exactly one proxy (Railway), so each person gets their own login limit", () => {
  assert.equal(createApp(noCalls, "mock").get("trust proxy"), 1);
});

test("hideServerPaths: only file names for stored files, no paths for extra PDFs; everything else untouched", () => {
  const when = new Date("2026-10-27T10:00:00Z");
  const out = hideServerPaths({
    run: { id: "r1", sourceFilePath: "/app/uploads/abc-Yoga.xlsx", resultFilePath: null, createdAt: when },
    reports: [
      { id: "p1", clientPdfPath: "C:\\data\\reports\\p1.pdf", customPdfPath: "/app/reports/p1-custom-x.pdf", extraAttachments: [{ id: "e1", filename: "GA.pdf", path: "/app/reports/extra/e1.pdf" }] },
    ],
    note: "the word path stays",
  }) as { run: Record<string, unknown>; reports: Record<string, unknown>[]; note: string };
  assert.equal(out.run.sourceFilePath, "abc-Yoga.xlsx");
  assert.equal(out.run.resultFilePath, null);
  assert.equal(out.run.createdAt, when, "dates are kept as they are");
  assert.equal(out.reports[0].clientPdfPath, "p1.pdf");
  assert.equal(out.reports[0].customPdfPath, "p1-custom-x.pdf");
  assert.deepEqual(out.reports[0].extraAttachments, [{ id: "e1", filename: "GA.pdf" }]);
  assert.equal(out.note, "the word path stays");
});

// P3 (audit 2026-10-27): requests that are simply wrong get a clear 4xx, not a bare 500 -- and two small headers.
test("a file over the upload limit gets 413 'too large', not a server error", async () => {
  const auth = await createAuthenticatedSession();
  try {
    const res = await request(createApp(noCalls, "mock"))
      .post("/api/runs/validate")
      .set("Cookie", auth.cookieHeader)
      .field("clientId", "x")
      .attach("file", Buffer.alloc(26 * 1024 * 1024), "huge.xlsx");
    assert.equal(res.status, 413);
    assert.match(res.body.error, /too large/);
  } finally {
    await auth.cleanup();
  }
});

test("broken JSON gets a 400 with a JSON error; a malformed cookie is ignored instead of breaking every request", async () => {
  const app = createApp(noCalls, "mock");
  const bad = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send('{"email": ');
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, "string");
  const me = await request(app).get("/api/auth/me").set("Cookie", "serp_session=%E0%A4%A; other=1");
  assert.equal(me.status, 401, "treated as signed out, not a 500");
});

test("no 'X-Powered-By: Express'; nosniff and a referrer policy are sent", async () => {
  const res = await request(createApp(noCalls, "mock")).get("/api/health");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
});
// Audit 2026-10-27: a download named with a "–", a curly apostrophe or non-English letters made Node refuse
// the header -- a 500 instead of the file.
test("downloads work with any file name (dash, curly apostrophe, non-English letters)", async () => {
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: "Name Test", workspaceId: auth.workspace.id } });
  try {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS));
    sheet.addRow(["yoga", "https://example.com/", "*example.*", "yoga example", "Australia", "google.com.au", "English", "Pending", "", ""]);
    const app = createApp(noCalls, "mock");
    const name = "Yoga – Peace’s योग keywords.xlsx";
    const up = await request(app).post("/api/runs").set("Cookie", auth.cookieHeader).field("clientId", client.id).attach("file", Buffer.from(await wb.xlsx.writeBuffer()), name);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const res = await request(app).get(`/api/runs/${up.body.run.id}/export`).set("Cookie", auth.cookieHeader);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-disposition"], /filename\*=UTF-8''/);
  } finally {
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    for (const r of runs) await prisma.rankingRow.deleteMany({ where: { runId: r.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});