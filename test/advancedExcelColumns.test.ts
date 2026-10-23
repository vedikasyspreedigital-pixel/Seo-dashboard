import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { createApp } from "../backend/api/app.js";
import { prisma } from "../backend/db/client.js";
import { COLUMN_HEADERS } from "../backend/excel/mapping.js";
import { parseRankingExcel } from "../backend/excel/parser.js";
import { normalizeKeyword } from "../backend/baselines/normalizeKeyword.js";
import { changeLabel } from "../backend/excel/exportRunExcel.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";

// Advanced SEO flow (2026-10-16): the run's "Download Excel" shows the last
// baseline next to the new ranks -- "Previous (<date>)" | "Ranks" | "Change"
// -- so the team verifies against it; the verified upload / comparison /
// email flow is unchanged. SEO's Excel is unchanged.

let auth: AuthFixture;
let advancedWorkspaceId: string;
test.before(async () => {
  auth = await createAuthenticatedSession();
  const adv = await prisma.workspace.upsert({ where: { slug: "advanced-seo" }, update: {}, create: { slug: "advanced-seo", name: "Advanced SEO" } });
  advancedWorkspaceId = adv.id;
  await prisma.workspaceMembership.create({ data: { userId: auth.user.id, workspaceId: adv.id } });
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});

const unused: CallDataForSeoFn = async () => ({ httpStatus: 200, body: { status_code: 20000, tasks: [] } });
const KEYWORDS = ["divorce for nri living abroad", "family lawyer in mumbai", "brand new keyword"];

async function workbook(extraHeader?: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow([...Object.values(COLUMN_HEADERS), ...(extraHeader ?? [])]);
  for (const k of KEYWORDS) ws.addRow([k, "example.com", "*example.*", k, "India", "google.co.in", "English", "Pending", "", ""]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function setupRun(workspaceId: string, withBaseline: boolean) {
  const app = createApp(unused, "mock");
  const client = await prisma.client.create({ data: { name: `Excel cols ${randomUUID()}`, workspaceId } });
  const up = await authedRequest(app, auth.cookieHeader).post("/api/runs").field("clientId", client.id).attach("file", await workbook(), "run.xlsx");
  const runId = up.body.run.id as string;
  await prisma.rankingRun.update({ where: { id: runId }, data: { status: "COMPLETED", completedAt: new Date("2026-10-14T06:00:00Z") } });
  const ranks: Record<string, [number | null, string]> = { [KEYWORDS[0]]: [5, "5"], [KEYWORDS[1]]: [null, "Not in 100"], [KEYWORDS[2]]: [12, "12"] };
  for (const [k, [v, d]] of Object.entries(ranks)) await prisma.rankingRow.updateMany({ where: { runId, keyword: k }, data: { status: "COMPLETED", rankValue: v, rankDisplay: d } });
  if (withBaseline) {
    await prisma.rankingBaseline.create({
      data: {
        clientId: client.id, sourceFilename: "5oct.xlsx", sourceType: "EXCEL", baselineDate: new Date("2026-10-05T00:00:00Z"),
        rows: { create: [{ keyword: KEYWORDS[0], normalizedKeyword: normalizeKeyword(KEYWORDS[0]), rankValue: 8, rankDisplay: "8" }, { keyword: KEYWORDS[1], normalizedKeyword: normalizeKeyword(KEYWORDS[1]), rankValue: 30, rankDisplay: "30" }] },
      },
    });
  }
  return { app, client, runId };
}

async function download(app: ReturnType<typeof createApp>, runId: string): Promise<Buffer> {
  const res = await authedRequest(app, auth.cookieHeader)
    .get(`/api/runs/${runId}/export`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  return res.body as Buffer;
}

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ""));
  const cell = (row: number, header: string) => ws.getRow(row).getCell(headers.indexOf(header) + 1).value;
  return { headers, cell };
}

async function cleanup(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.rankingBaselineRow.deleteMany({ where: { baseline: { clientId } } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("changeLabel: same wording as the PDF", () => {
  assert.equal(changeLabel({ rankValue: 8 }, 5), "↑ +3");
  assert.equal(changeLabel({ rankValue: 5 }, 8), "↓ -3");
  assert.equal(changeLabel({ rankValue: 5 }, 5), "→ 0");
  assert.equal(changeLabel({ rankValue: 30 }, null), "↓ Lost");
  assert.equal(changeLabel({ rankValue: null }, 12), "↑ New");
  assert.equal(changeLabel(undefined, 12), "↑ New");
  assert.equal(changeLabel(undefined, null), "-");
  assert.equal(changeLabel({ rankValue: null }, null), "-");
});

test("Advanced SEO Download Excel: Previous (date) | Ranks | Change, from the baseline; still a valid verified-upload file", async () => {
  const { app, client, runId } = await setupRun(advancedWorkspaceId, true);
  try {
    const buf = await download(app, runId);
    const { headers, cell } = await sheetOf(buf);
    const r = headers.indexOf("Ranks");
    assert.deepEqual(headers.slice(r - 1, r + 2), ["Previous (5th October 2026)", "Ranks", "Change"]);
    assert.deepEqual([cell(2, "Previous (5th October 2026)"), cell(2, "Ranks"), cell(2, "Change")], [8, "5", "↑ +3"]);
    assert.deepEqual([cell(3, "Previous (5th October 2026)"), cell(3, "Ranks"), cell(3, "Change")], [30, "Not in 100", "↓ Lost"]);
    assert.deepEqual([cell(4, "Previous (5th October 2026)"), cell(4, "Ranks"), cell(4, "Change")], ["-", "12", "↑ New"]);

    // The verified upload reads this file exactly as before (columns found by header name).
    const parsed = await parseRankingExcel(buf, { clientId: client.id });
    assert.deepEqual((parsed.rows as { keyword: string; rankDisplay: string | null }[]).map((x) => [x.keyword, x.rankDisplay]), [[KEYWORDS[0], "5"], [KEYWORDS[1], "Not in 100"], [KEYWORDS[2], "12"]]);

    // Downloading a file that already has the columns refreshes them -- never duplicates.
    const run = await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
    await writeFile(run.sourceFilePath, buf);
    const again = await sheetOf(await download(app, runId));
    assert.equal(again.headers.filter((h) => h.startsWith("Previous (")).length, 1);
    assert.equal(again.headers.filter((h) => h === "Change").length, 1);
    assert.equal(again.cell(2, "Change"), "↑ +3");
  } finally {
    await cleanup(client.id);
  }
});

test("Advanced SEO without any baseline yet, and SEO clients: Download Excel is unchanged", async () => {
  for (const [workspaceId, withBaseline] of [[advancedWorkspaceId, false], [auth.workspace.id, true]] as const) {
    const { app, client, runId } = await setupRun(workspaceId, withBaseline);
    try {
      const { headers } = await sheetOf(await download(app, runId));
      assert.deepEqual(headers, Object.values(COLUMN_HEADERS), `no extra columns (${workspaceId === advancedWorkspaceId ? "advanced, no baseline" : "seo"})`);
    } finally {
      await cleanup(client.id);
    }
  }
});
