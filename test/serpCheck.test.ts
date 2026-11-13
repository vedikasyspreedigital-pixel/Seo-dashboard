import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { processRun } from "../backend/worker/processRun.js";
import { checkSerp, organicSites, sharedShare } from "../backend/dataforseo/serpCheck.js";
import { buildDiagnostics } from "../backend/dataforseo/runDiagnostics.js";
import type { DataForSeoCallResult } from "../backend/dataforseo/client.js";

// "Poisoned SERP" check (2026-11-12): a results page that doesn't look like the keyword's usual page (fewer than
// half of the previous run's top-20 sites anywhere on it -- DataForSEO's own definition) is asked for once more.

const noSleep = async () => {};
const usual = Array.from({ length: 20 }, (_, i) => `usual${i + 1}.com.au`);
const other = Array.from({ length: 20 }, (_, i) => `unrelated${i + 1}.com`);

/** A full results page: these sites in order, with the client at `clientAt` (1-based) if given. */
function page(sites: string[], clientAt?: number) {
  const list = [...sites];
  if (clientAt) list.splice(clientAt - 1, 0, "www.example.com.au");
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [{ pages_count: 10, se_results_count: 1000, items: list.map((s, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url: `https://${s}/page`, domain: s })) }],
      },
    ],
  };
}

test("organicSites / sharedShare: sites in order, Google redirects via their breadcrumb; too few sites can't be judged", () => {
  const body = { tasks: [{ result: [{ items: [
    { type: "organic", rank_group: 2, url: "https://b.com/x" },
    { type: "organic", rank_group: 1, url: "https://www.a.com/" },
    { type: "paid", rank_group: 1, url: "https://ad.com/" },
    { type: "organic", rank_group: 3, url: "https://google.com.au/goto?url=CAES", breadcrumb: "https://www.c.com.au › services" },
    { type: "organic", rank_group: 4, url: "https://a.com/other" },
  ] }] }] };
  assert.deepEqual(organicSites(body), ["a.com", "b.com", "c.com.au"]);
  assert.equal(sharedShare(usual, [...usual.slice(0, 10), ...other]), 0.5);
  assert.equal(sharedShare(usual.slice(0, 3), usual), null, "too few sites to judge");
});

test("checkSerp: usual page -> used as is; poisoned then normal -> second; two matching new pages -> really changed; else unconfirmed", async () => {
  const wrap = (b: unknown) => ({ body: b, result: b });
  let asked = 0;
  const ask = (b: unknown) => async () => ((asked++), wrap(b));

  asked = 0;
  let r = await checkSerp(wrap(page(usual)), usual, ask(page(other)));
  assert.equal(r.check.status, "ok");
  assert.equal(asked, 0, "no extra call for a normal page");

  r = await checkSerp(wrap(page(other)), null, ask(page(usual)));
  assert.equal(r.check.status, "no_previous");
  assert.equal(asked, 0);

  r = await checkSerp(wrap(page(other)), usual, ask(page(usual)));
  assert.equal(r.check.status, "ok_after_retry");
  assert.equal(r.use.body, r.use.result);
  assert.deepEqual(organicSites(r.use.body).slice(0, 2), ["usual1.com.au", "usual2.com.au"]);

  r = await checkSerp(wrap(page(other)), usual, ask(page(other)));
  assert.equal(r.check.status, "changed", "asked twice, same new page: Google's page really changed");

  const third = Array.from({ length: 20 }, (_, i) => `third${i}.net`);
  r = await checkSerp(wrap(page(other)), usual, ask(page(third)));
  assert.equal(r.check.status, "suspect");

  r = await checkSerp(wrap(page(other)), usual, async () => null);
  assert.equal(r.check.status, "suspect", "the extra call failed: first page kept, flagged");
});

async function setup() {
  const client = await prisma.client.create({ data: { name: `Poison check ${randomUUID()}` } });
  const mkRun = (createdAt: Date, status: "COMPLETED" | "PROCESSING") =>
    prisma.rankingRun.create({ data: { clientId: client.id, sourceFilename: "p.xlsx", sourceFilePath: "x", totalRows: 1, status, createdAt, startedAt: createdAt } });
  const mkRow = (runId: string, status: "COMPLETED" | "PENDING") =>
    prisma.rankingRow.create({
      data: { runId, rowUid: randomUUID(), sourceRowNumber: 1, keyword: "it managed services sydney", targetUrl: "*example.*", fullUrl: "https://www.example.com.au", locationName: "Australia", seDomain: "google.com.au", languageName: "English", status },
    });
  const prevRun = await mkRun(new Date("2026-11-01T00:00:00Z"), "COMPLETED");
  const prevRow = await mkRow(prevRun.id, "COMPLETED");
  await prisma.rankingRowAttempt.create({ data: { rankingRowId: prevRow.id, attemptNumber: 1, requestPayload: {}, httpStatus: 200, dataforseoStatusCode: 20000, rawResponse: page(usual, 3), outcome: "SUCCESS" } });
  const run = await mkRun(new Date("2026-11-12T00:00:00Z"), "PROCESSING");
  const row = await mkRow(run.id, "PENDING");
  const cleanup = async () => {
    for (const r of [prevRow, row]) await prisma.rankingRowAttempt.deleteMany({ where: { rankingRowId: r.id } });
    await prisma.rankingRow.deleteMany({ where: { runId: { in: [prevRun.id, run.id] } } });
    await prisma.notification.deleteMany({ where: { runId: { in: [prevRun.id, run.id] } } }).catch(() => {});
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  };
  return { run, row, cleanup };
}

test("processRun: a poisoned first page is asked for again and the real page's rank is used", async () => {
  const t = await setup();
  try {
    const answers = [page(other), page(usual, 2)];
    let calls = 0;
    const call = async (): Promise<DataForSeoCallResult> => ({ httpStatus: 200, body: answers[calls++] });
    await processRun(t.run.id, call, { sleep: noSleep });
    assert.equal(calls, 2, "one extra call");
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: t.row.id } });
    assert.equal(row.rankValue, 2, "rank from the second (real) page");
    assert.equal((row.serpCheck as { status: string }).status, "ok_after_retry");
    assert.equal(await prisma.rankingRowAttempt.count({ where: { rankingRowId: t.row.id } }), 1, "one attempt recorded (the page used)");

    const diag = buildDiagnostics("live", [{ ...row, serpCheck: row.serpCheck }], []);
    assert.deepEqual(diag.summary.pageCheck, { checked: 1, reAsked: 1, changed: 0, unconfirmed: 0 });
  } finally {
    await t.cleanup();
  }
});

test("processRun: a normal page costs no extra call; the check can be switched off", async () => {
  const t = await setup();
  try {
    let calls = 0;
    await processRun(t.run.id, async () => ((calls++), { httpStatus: 200, body: page(usual, 5) }), { sleep: noSleep });
    assert.equal(calls, 1);
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: t.row.id } });
    assert.equal(row.rankValue, 5);
    assert.equal((row.serpCheck as { status: string }).status, "ok");
  } finally {
    await t.cleanup();
  }

  const t2 = await setup();
  const prev = process.env.DATAFORSEO_POISON_CHECK;
  process.env.DATAFORSEO_POISON_CHECK = "0";
  try {
    let calls = 0;
    await processRun(t2.run.id, async () => ((calls++), { httpStatus: 200, body: page(other, 7) }), { sleep: noSleep });
    assert.equal(calls, 1, "switched off: no extra call even for an odd page");
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: t2.row.id } });
    assert.equal(row.serpCheck, null);
  } finally {
    if (prev === undefined) delete process.env.DATAFORSEO_POISON_CHECK;
    else process.env.DATAFORSEO_POISON_CHECK = prev;
    await t2.cleanup();
  }
});
