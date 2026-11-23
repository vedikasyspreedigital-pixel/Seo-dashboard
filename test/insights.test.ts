import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Client view + portfolio (2026-11-23): history = baselines (sent/imported reports) + the newer unverified run.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("no rank checks here");
};

let auth: AuthFixture;
let other: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
  other = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await other.cleanup();
  await prisma.$disconnect();
});

async function baseline(clientId: string, date: string, ranks: Record<string, number | null>) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: `${date}.xlsx`,
      sourceType: "EXCEL",
      baselineDate: new Date(date),
      rows: { create: Object.entries(ranks).map(([keyword, rank]) => ({ keyword, normalizedKeyword: keyword.toLowerCase(), rankValue: rank, rankDisplay: rank === null ? "Not in 100" : String(rank) })) },
    },
  });
}

test("client view: trend from baselines + the newer run, keyword history, movement; portfolio flags a due report", async () => {
  const api = authedRequest(createApp(neverCalled, "mock"), auth.cookieHeader);
  const client = await prisma.client.create({ data: { name: `Insights ${randomUUID().slice(0, 6)}`, workspaceId: auth.workspace.id, reportTypeConfirmed: true } });
  try {
    await baseline(client.id, "2026-10-01T00:00:00Z", { "divorce lawyer": 12, "custody lawyer": 2, "nri lawyer": null });
    await baseline(client.id, "2026-10-15T00:00:00Z", { "divorce lawyer": 8, "custody lawyer": 3, "nri lawyer": 40 });
    const run = await prisma.rankingRun.create({ data: { clientId: client.id, sourceFilename: "kw.xlsx", sourceFilePath: "x", totalRows: 3, status: "COMPLETED", completedAt: new Date("2026-11-01T00:00:00Z") } });
    for (const [i, [keyword, rank]] of ([["Divorce Lawyer", 5], ["custody lawyer", 3], ["nri lawyer", null]] as const).entries()) {
      await prisma.rankingRow.create({
        data: { runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*x.*", locationName: "India", seDomain: "google.co.in", languageName: "English", status: "COMPLETED", rankValue: rank },
      });
    }

    const res = await api.get(`/api/insights/clients/${client.id}`);
    assert.equal(res.status, 200);
    const d = res.body;
    assert.deepEqual(d.trend.map((t: { kind: string }) => t.kind), ["baseline", "baseline", "run"]);
    assert.deepEqual(d.trend.map((t: { top3: number; top10: number; top100: number }) => [t.top3, t.top10, t.top100]), [[1, 1, 2], [1, 2, 3], [1, 2, 2]]);
    const divorce = d.keywords.find((k: { keyword: string }) => k.keyword === "Divorce Lawyer");
    assert.deepEqual(divorce.ranks, [12, 8, 5]); // matched across case
    assert.equal(divorce.previous, 8);
    assert.deepEqual(d.movement, { improved: 1, declined: 1, unchanged: 1 }); // divorce up, nri 40 -> not ranked, custody same
    assert.equal(d.client.reportType, "normal");

    const portfolio = (await api.get(`/api/insights/portfolio?workspaceId=${auth.workspace.id}`)).body;
    const row = portfolio.clients.find((c: { clientId: string }) => c.clientId === client.id);
    assert.equal(row.latestKind, "run");
    assert.deepEqual(row.latest, { total: 3, top3: 1, top10: 2, top100: 2 });
    assert.equal(row.reportDue, true); // never sent

    // Other teams can't read it.
    const outsider = authedRequest(createApp(neverCalled, "mock"), other.cookieHeader);
    assert.equal((await outsider.get(`/api/insights/clients/${client.id}`)).status, 404);
    assert.equal((await outsider.get(`/api/insights/portfolio?workspaceId=${auth.workspace.id}`)).status, 404);
  } finally {
    const runs = await prisma.rankingRun.findMany({ where: { clientId: client.id }, select: { id: true } });
    await prisma.rankingRow.deleteMany({ where: { runId: { in: runs.map((r) => r.id) } } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    const bs = await prisma.rankingBaseline.findMany({ where: { clientId: client.id }, select: { id: true } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: { in: bs.map((b) => b.id) } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  }
});
