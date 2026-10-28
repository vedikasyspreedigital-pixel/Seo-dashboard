import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Confirming a baseline import (POST /api/clients/:id/baselines) -- found in the 2026-10-27 audit:
// a big client's rows didn't fit the 100kb JSON default (413), and any rank value was stored as-is.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("no DataForSEO here");
};

async function setup() {
  const auth = await createAuthenticatedSession();
  const client = await prisma.client.create({ data: { name: `Baselines API ${randomUUID()}`, workspaceId: auth.workspace.id } });
  const api = authedRequest(createApp(neverCalled, "mock"), auth.cookieHeader);
  const cleanup = async () => {
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: { in: baselines.map((b) => b.id) } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  };
  return { api, client, cleanup };
}

const body = (rows: unknown[]) => ({ sourceFilename: "Sep rankings.xlsx", sourceType: "EXCEL", baselineDate: "2026-09-30", rows });

test("baseline confirm: a 2,000-keyword import (well over 100kb of JSON) is saved", async () => {
  const t = await setup();
  try {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ keyword: `yoga classes suburb number ${i} near me`, rankValue: (i % 100) + 1, rankDisplay: String((i % 100) + 1) }));
    assert.ok(JSON.stringify(body(rows)).length > 100 * 1024);
    const res = await t.api.post(`/api/clients/${t.client.id}/baselines`).send(body(rows));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.rowCount, 2000);
  } finally {
    await t.cleanup();
  }
});

test("baseline confirm: ranks outside 1-100 (or not whole numbers) are refused; empty = Not in 100 is fine", async () => {
  const t = await setup();
  try {
    for (const rankValue of [0, -3, 101, 4.5, "7"]) {
      const res = await t.api.post(`/api/clients/${t.client.id}/baselines`).send(body([{ keyword: "yoga", rankValue, rankDisplay: String(rankValue) }]));
      assert.equal(res.status, 400, `rank ${JSON.stringify(rankValue)}`);
    }
    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: t.client.id } }), 0, "nothing stored");
    const ok = await t.api.post(`/api/clients/${t.client.id}/baselines`).send(body([{ keyword: "yoga", rankValue: 1, rankDisplay: "1" }, { keyword: "pilates", rankValue: null, rankDisplay: "Not in 100" }]));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally {
    await t.cleanup();
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
