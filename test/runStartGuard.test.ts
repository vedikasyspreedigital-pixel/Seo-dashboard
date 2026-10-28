import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { callDataForSeoLive } from "../backend/dataforseo/client.js";
import { COLUMN_HEADERS } from "../backend/excel/parser.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";

// Audit 2026-10-27 (M6): in live mode without DataForSEO's login, a started run hung on its first keyword
// for good. It's refused up front instead, and nothing about the run changes.

test("start in live mode without DataForSEO's login: refused with a clear message, run untouched", async () => {
  const saved = { login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD };
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `No DataForSEO login ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const api = authedRequest(createApp(callDataForSeoLive, "live"), auth.cookieHeader);
  try {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS));
    sheet.addRow(["yoga", "https://example.com/", "*example.*", "yoga example", "Australia", "google.com.au", "English", "Pending", "", ""]);
    const up = await api.post("/api/runs").field("clientId", client.id).attach("file", Buffer.from(await wb.xlsx.writeBuffer()), "no-login.xlsx");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const runId = up.body.run.id;

    const res = await api.post(`/api/runs/${runId}/start`);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /login details .* aren't set/);
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } })).status, "UPLOADED", "not started");
    assert.equal(await prisma.rankingRow.count({ where: { runId, status: "PROCESSING" } }), 0);
  } finally {
    if (saved.login !== undefined) process.env.DATAFORSEO_LOGIN = saved.login;
    if (saved.password !== undefined) process.env.DATAFORSEO_PASSWORD = saved.password;
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    for (const r of runs) await prisma.rankingRow.deleteMany({ where: { runId: r.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

// Audit 2026-10-27 (M7): two upload clicks at the same moment both passed the "same file in the last 10s"
// check before either run existed -- two runs. (M13): deleting a run only removes files in the app's own
// uploads/reports folders -- a run whose path was the bare uploaded name could delete e.g. package.json.
test("two identical uploads at the same moment make ONE run; deleting a run never touches files outside the app's folders", async () => {
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Double upload ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const api = authedRequest(createApp(callDataForSeoLive, "live"), auth.cookieHeader);
  const { writeFile, stat, rm } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const outside = path.join(process.cwd(), `do-not-delete-${randomUUID()}.txt`);
  try {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    sheet.addRow(Object.values(COLUMN_HEADERS));
    for (let i = 0; i < 400; i++) sheet.addRow([`keyword ${i}`, "https://example.com/", "*example.*", "x", "Australia", "google.com.au", "English", "Pending", "", ""]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const [a, b] = await Promise.all([
      api.post("/api/runs").field("clientId", client.id).attach("file", buf, "same.xlsx"),
      api.post("/api/runs").field("clientId", client.id).attach("file", buf, "same.xlsx"),
    ]);
    assert.ok([a.status, b.status].every((s) => s === 200 || s === 201), `${a.status} ${b.status}`);
    assert.equal(a.body.run.id, b.body.run.id, "both clicks get the same run");
    assert.equal(await prisma.rankingRun.count({ where: { clientId: client.id } }), 1);

    // A run whose stored path is a bare name (as when saving the upload failed) -- deleting it must not delete that file.
    await writeFile(outside, "keep me");
    await prisma.rankingRun.update({ where: { id: a.body.run.id }, data: { sourceFilePath: outside } });
    assert.equal((await api.delete(`/api/runs/${a.body.run.id}`)).status, 204);
    await stat(outside); // still there
  } finally {
    await rm(outside, { force: true });
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id } });
    for (const r of runs) await prisma.rankingRow.deleteMany({ where: { runId: r.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
