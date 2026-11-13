import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { createTargetMatcher, applyTargetFilter, urlFromBreadcrumb } from "../backend/dataforseo/targetMatch.js";
import { buildDiagnostics, diagnoseRun, clientDomainOf } from "../backend/dataforseo/runDiagnostics.js";
import { mapDataForSeoResponse } from "../backend/dataforseo/mapResponse.js";
import { createMockStandardClient } from "../backend/dataforseo/mockStandardClient.js";
import type { StandardClient, StandardTaskPayload } from "../backend/dataforseo/standardClient.js";
import {
  buildStandardTask,
  collectFinished,
  recoverStandardTasksOnStartup,
  submitDueRows,
  pickMedianReading,
  standardReadings,
  STANDARD_RETRY_DELAYS_MS,
  LOST_AFTER_MS,
} from "../backend/worker/standardQueue.js";
import { recoverStaleProcessingRows } from "../backend/worker/recoverStaleRuns.js";
import { assignEngine } from "../backend/dataforseo/engine.js";
import { cancelRun } from "../backend/statemachine/runTransitions.js";

// DataForSEO Standard (queue) method -- backend/worker/standardQueue.ts. All
// in ONE file on purpose: the queue works on every standard run in the
// database, and node runs test files in parallel.

// ---------------------------------------------------------------- target matching (no DB)

test("target matching follows DataForSEO's Live `target` rules", () => {
  const m = (target: string) => createTargetMatcher(target)!;
  assert.equal(m("*avnprofessional.*")("https://www.avnprofessional.com/know-about-api/"), true);
  assert.equal(m("*avnprofessional.*")("https://avnprofessional.in/"), true);
  assert.equal(m("*avnprofessional.*")("https://www.other.com/avnprofessional.html"), true, "a leading * matches anything before it -- even another site's path (to compare with Live in the side-by-side test)");
  assert.equal(m("*avnprofessional.*")("https://www.other.com/avnprofessional"), false, "needs the '.' after the name");
  assert.equal(m("*avnprofessional.*")("https://www.competitor.com/"), false);
  assert.equal(m("example.com")("https://www.example.com/"), true, "home page, www and trailing / ignored");
  assert.equal(m("example.com")("https://example.com/services"), false, "no * = that page only");
  assert.equal(m("example.com*")("https://example.com/services/x"), true);
  assert.equal(m("example.com*")("https://blog.example.com/"), false, "subdomains need a leading *");
  assert.equal(m("*example.com*")("https://blog.example.com/a"), true);
  assert.equal(m("*example.com")("https://en.example.com/"), true, "home page on any subdomain");
  assert.equal(m("example.com/example-page")("https://www.example.com/example-page/"), true);
  assert.equal(m("EXAMPLE.com*")("HTTPS://Example.COM/Page"), true, "case-insensitive");
  assert.equal(createTargetMatcher(""), null);
  assert.equal(createTargetMatcher("*"), null, "a bare * would match every result -- treated as no target");
});

function serp(items: { rank: number; url: string; type?: string; breadcrumb?: string }[], { pagesCount = 10, statusCode = 20000 } = {}) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        id: "t1",
        status_code: statusCode,
        status_message: statusCode === 20000 ? "Ok." : "Error.",
        result: [{ keyword: "k", pages_count: pagesCount, items_count: items.length, items: items.map((i) => ({ type: i.type ?? "organic", rank_group: i.rank, url: i.url, domain: new URL(i.url).host, ...(i.breadcrumb ? { breadcrumb: i.breadcrumb } : {}) })) }],
      },
    ],
  };
}

test("applyTargetFilter: a full Standard SERP maps to the same rank Live's target filter gave", () => {
  const body = serp([
    { rank: 1, url: "https://competitor.com/" },
    { rank: 1, url: "https://www.client-site.com/ad", type: "paid" },
    { rank: 2, url: "https://www.client-site.com/services/" },
    { rank: 5, url: "https://www.client-site.com/" },
  ]);
  const filtered = applyTargetFilter(body, "*client-site.*");
  assert.equal(body.tasks[0].result[0].items.length, 4, "the raw response is never changed (it's what gets saved)");
  assert.equal(filtered.tasks[0].result[0].pages_count, 10);
  const mapped = mapDataForSeoResponse({ body: filtered, requestPayload: { depth: 100 } });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 2, "best organic match -- the paid ad at 1 is ignored like before");
  assert.equal(mapped.rankingUrl, "https://www.client-site.com/services/");
});

test("applyTargetFilter: client not found -> 'Not in 100' only after a full crawl, else retried (shallow-coverage rule kept)", () => {
  const full = mapDataForSeoResponse({ body: applyTargetFilter(serp([{ rank: 1, url: "https://competitor.com/" }], { pagesCount: 10 }), "*client-site.*"), requestPayload: { depth: 100 } });
  assert.equal(full.outcome, "SUCCESS");
  assert.equal(full.rankDisplay, "Not in 100");
  const shallow = mapDataForSeoResponse({ body: applyTargetFilter(serp([{ rank: 1, url: "https://competitor.com/" }], { pagesCount: 3 }), "*client-site.*"), requestPayload: { depth: 100 } });
  assert.equal(shallow.outcome, "API_ERROR");
  assert.equal(shallow.retryable, true);
});

test("buildStandardTask: the Live request without `target`, plus our tag and priority", () => {
  const payload = buildStandardTask(
    { keyword: "fencing brisbane", targetUrl: "*bayfencing.*", fullUrl: "https://bayfencing.com.au", locationName: "Australia", seDomain: "Google.com.au", languageName: "English" },
    "tag-1",
    1,
  );
  assert.equal("target" in payload, false);
  assert.equal(payload.tag, "tag-1");
  assert.equal(payload.priority, 1);
  assert.equal(payload.depth, 100);
  assert.equal(payload.se_domain, "google.com.au");
  assert.deepEqual(payload.stop_crawl_on_match, [{ match_type: "with_subdomains", match_value: "bayfencing.com.au" }]);
});

test("Unified Rank Matcher: a Google redirect link is matched by its breadcrumb (the client's address is hidden since ~30 Oct)", () => {
  assert.equal(urlFromBreadcrumb("https://www.client-site.com › services › …"), "https://www.client-site.com/services");
  assert.equal(urlFromBreadcrumb("20+ reactions · 7 years ago"), null, "not an address");
  const body = serp([
    { rank: 1, url: "https://competitor.com/" },
    { rank: 2, url: "https://google.com.au/goto?url=AAA" },
    { rank: 3, url: "https://google.com.au/goto?url=BBB" },
  ]);
  const items = body.tasks[0].result[0].items as Record<string, unknown>[];
  items[1].breadcrumb = "https://www.other-site.com › page";
  items[2].breadcrumb = "https://www.client-site.com › services › …";
  const filtered = applyTargetFilter(body, "*client-site.*");
  const mapped = mapDataForSeoResponse({ body: filtered, requestPayload: { depth: 100 } });
  assert.equal(mapped.rankValue, 3, "found via its breadcrumb -- before, a redirect item never matched and this was 'Not in 100'");
  assert.equal(mapped.rankingUrl, "https://www.client-site.com/services", "the rebuilt address is recorded, not the redirect link");
  assert.equal(filtered.tasks[0].result[0].items[0].google_url, "https://google.com.au/goto?url=BBB");
  assert.equal((body.tasks[0].result[0].items[2] as Record<string, unknown>).url, "https://google.com.au/goto?url=BBB", "the saved raw answer is unchanged");
});

test("debug details: tries by status code, early stops, and a counted URL on another website is flagged", () => {
  assert.equal(clientDomainOf("https://www.client-site.com/x", "*client-site.*"), "client-site.com");
  assert.equal(clientDomainOf(null, "*client-site.com.au*"), "client-site.com.au", "no Full URL: from the target pattern");
  const row = (id: string, rankingUrl: string | null, rank: string | null) => ({
    id, keyword: id, locationName: "Australia", status: "COMPLETED", rankDisplay: rank, rankingUrl, fullUrl: "https://client-site.com", targetUrl: "*client-site.*",
  });
  const tryOf = (rowId: string, n: number, code: number, pages: number, organic: number, redirects: number) => ({
    ranking_row_id: rowId, attempt_number: n, dataforseo_status_code: code, outcome: code === 20000 ? "SUCCESS" : "API_ERROR", error_message: null,
    mapped_rank_value: null, mapped_ranking_url: null, created_at: new Date("2026-11-05T05:00:00Z"), pages, organic, redirects, raw_kept: true,
  });
  const d = buildDiagnostics(
    "live",
    [row("ok", "https://blog.client-site.com/a", "4"), row("wrong", "https://www.other.com/client-site.html", "3"), row("retried", null, "Not in 100")],
    [tryOf("ok", 1, 20000, 1, 1, 0), tryOf("wrong", 1, 20000, 1, 1, 0), tryOf("retried", 1, 40102, 3, 0, 0), tryOf("retried", 2, 40102, 10, 0, 0)],
  );
  assert.deepEqual(d.rows.map((r) => r.otherSite), [false, true, false], "a subdomain is the client's; other.com/client-site.html (matched by *client-site.*) is not");
  assert.equal(d.summary.otherSiteMatches, 1);
  assert.equal(d.summary.earlyStops, 1, "the 3-page 40102, not the full 10-page one");
  assert.deepEqual(d.summary.byStatusCode.map((c) => [c.code, c.tries, c.avgPages]), [[20000, 2, 1], [40102, 2, 6.5]]);
  assert.deepEqual(d.rows[2].attempts.map((a) => a.pages), [3, 10]);
});

// ---------------------------------------------------------------- queue (DB)

async function makeStandardRun(keywords: string[], { status = "PROCESSING" as "PROCESSING" | "UPLOADED" } = {}) {
  const client = await prisma.client.create({ data: { name: `Standard Queue Test - ${randomUUID()}` } });
  const run = await prisma.rankingRun.create({
    data: { clientId: client.id, sourceFilename: "standard.xlsx", sourceFilePath: "local-test/standard.xlsx", totalRows: keywords.length, status, engine: "standard", startedAt: new Date() },
  });
  const rows = [];
  for (const [i, keyword] of keywords.entries()) {
    rows.push(
      await prisma.rankingRow.create({
        data: { runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*client-site.*", fullUrl: "https://client-site.com", locationName: "Australia", seDomain: "google.com.au", languageName: "English", maxRetries: 3 },
      }),
    );
  }
  return { client, run, rows };
}

async function cleanup(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.dataforseoTask.deleteMany({ where: { runId: run.id } });
    await prisma.rankingRow.updateMany({ where: { runId: run.id }, data: { lastAttemptId: null } });
    await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: run.id } } });
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.notification.deleteMany({ where: { runId: { in: runs.map((r) => r.id) } } }).catch(() => {});
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

/** A scriptable Standard API: tests decide what each call answers. */
function fakeClient(script: {
  post?: (tasks: StandardTaskPayload[]) => { httpStatus?: number; body?: unknown; transportError?: Error };
  get?: (id: string, task: StandardTaskPayload) => unknown;
}) {
  const posted = new Map<string, StandardTaskPayload>();
  const calls = { post: 0, ready: 0, get: 0 };
  const client: StandardClient = {
    async postTasks(tasks) {
      calls.post++;
      if (script.post) return script.post(tasks);
      const entries = tasks.map((t) => {
        const id = randomUUID();
        posted.set(id, t);
        return { id, status_code: 20100, status_message: "Task Created.", data: { ...t } };
      });
      return { httpStatus: 200, body: { status_code: 20000, tasks: entries } };
    },
    async tasksReady() {
      calls.ready++;
      return { httpStatus: 200, body: { status_code: 20000, tasks: [{ status_code: 20000, result: [...posted.keys()].map((id) => ({ id })) }] } };
    },
    async taskGet(id) {
      calls.get++;
      const task = posted.get(id);
      return { httpStatus: 200, body: script.get && task ? script.get(id, task) : serp([{ rank: 4, url: "https://www.client-site.com/" }]) };
    },
  };
  return { client, posted, calls };
}

const later = (ms: number) => () => new Date(Date.now() + ms);

test("queue: a standard run is submitted in one batch, waits while queued, then every row gets its rank and the run completes", async () => {
  const { client, run, rows } = await makeStandardRun(["alpha", "bravo", "charlie"]);
  try {
    let clock = Date.now();
    const api = createMockStandardClient({ readyAfterMs: 60_000, now: () => clock });

    assert.equal(await submitDueRows(api), 3);
    const tasks = await prisma.dataforseoTask.findMany({ where: { runId: run.id } });
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.status === "SUBMITTED" && t.dataforseoTaskId), "each row has its DataForSEO task id stored");
    assert.equal((await prisma.rankingRow.findMany({ where: { runId: run.id, status: "PROCESSING" } })).length, 3);
    assert.equal(await submitDueRows(api), 0, "nothing is posted twice");

    assert.equal(await collectFinished(api), 0, "still in DataForSEO's queue");
    clock += 61_000;
    assert.equal(await collectFinished(api), 3);

    for (const row of rows) {
      const done = await prisma.rankingRow.findUniqueOrThrow({ where: { id: row.id }, include: { attempts: true } });
      assert.equal(done.status, "COMPLETED", row.keyword);
      assert.equal(done.attempts.length, 1);
      const raw = done.attempts[0].rawResponse as { tasks: { result: { items: unknown[] }[] }[] };
      assert.ok(raw.tasks[0].result[0].items.length >= 1, "the full DataForSEO answer is saved as the attempt's raw response");
    }
    const finished = await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.match(finished.status, /^COMPLETED/);
    assert.ok((await prisma.dataforseoTask.findMany({ where: { runId: run.id } })).every((t) => t.status === "COLLECTED"));
  } finally {
    await cleanup(client.id);
  }
});

test("queue: two collectors at once (two ticks, or two servers mid-deploy) apply each result exactly once", async () => {
  const { client, run } = await makeStandardRun(["one", "two", "three", "four"]);
  try {
    const { client: api } = fakeClient({});
    await submitDueRows(api);
    await Promise.all([collectFinished(api), collectFinished(api), collectFinished(api)]);
    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id }, include: { attempts: true } });
    for (const row of rows) {
      assert.equal(row.status, "COMPLETED");
      assert.equal(row.attempts.length, 1, `${row.keyword}: one attempt, not one per collector`);
      assert.equal(row.rankValue, 4);
    }
  } finally {
    await cleanup(client.id);
  }
});

test("queue: a task DataForSEO refuses at post time (40501 bad location) fails that row only; the rest go through", async () => {
  const { client, run, rows } = await makeStandardRun(["good", "bad location"]);
  try {
    const { client: api } = fakeClient({
      post: (tasks) => ({
        httpStatus: 200,
        body: {
          status_code: 20000,
          tasks: tasks.map((t) =>
            t.keyword === "bad location"
              ? { id: randomUUID(), status_code: 40501, status_message: "Invalid Field: 'location_name'.", data: { ...t } }
              : { id: randomUUID(), status_code: 20100, status_message: "Task Created.", data: { ...t } },
          ),
        },
      }),
    });
    assert.equal(await submitDueRows(api), 1);
    const bad = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[1].id } });
    assert.equal(bad.status, "FAILED", "a permanent error isn't retried");
    assert.match(bad.lastErrorMessage ?? "", /location_name/);
    assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } })).status, "PROCESSING");
    assert.equal((await prisma.dataforseoTask.findFirstOrThrow({ where: { rankingRowId: rows[1].id } })).status, "FAILED");
    assert.ok(run);
  } finally {
    await cleanup(client.id);
  }
});

test("queue: task_post fails outright -> tries recorded, retried only after the Standard backoff", async () => {
  const { client, rows } = await makeStandardRun(["net down"]);
  try {
    let down = true;
    const fake = fakeClient({});
    const api: StandardClient = { ...fake.client, postTasks: async (t) => (down ? { transportError: new Error("socket hang up") } : fake.client.postTasks(t)) };

    assert.equal(await submitDueRows(api), 0);
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } });
    assert.equal(row.status, "ERROR_RETRY");
    assert.equal(row.retryCount, 1);
    assert.equal((await prisma.dataforseoTask.findFirstOrThrow({ where: { rankingRowId: row.id } })).status, "ABANDONED");

    down = false;
    assert.equal(await submitDueRows(api), 0, "not again straight away");
    assert.equal(await submitDueRows(api, { now: later(STANDARD_RETRY_DELAYS_MS[0] + 1_000) }), 1, "posted again once the 10-minute wait is over");
  } finally {
    await cleanup(client.id);
  }
});

test("queue: a DataForSEO error in the result (50401 timeout) is retried later, and fails after 3 tries", async () => {
  const { client, rows } = await makeStandardRun(["timeout keyword"]);
  try {
    const timeout = { status_code: 20000, tasks: [{ status_code: 50401, status_message: "Internal Error - Timeout.", result: null }] };
    const { client: api } = fakeClient({ get: () => timeout });

    await submitDueRows(api);
    await collectFinished(api);
    const afterFirst = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } });
    assert.equal(afterFirst.status, "ERROR_RETRY");

    await submitDueRows(api, { now: later(STANDARD_RETRY_DELAYS_MS[0] + 1_000) });
    await collectFinished(api);
    await submitDueRows(api, { now: later(STANDARD_RETRY_DELAYS_MS[1] + 1_000) });
    await collectFinished(api);
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id }, include: { attempts: true } });
    assert.equal(row.status, "FAILED");
    assert.equal(row.attempts.length, 3);
    assert.match(row.lastErrorMessage ?? "", /Timeout/);
  } finally {
    await cleanup(client.id);
  }
});

test("queue: a task DataForSEO no longer has (40401) is retried, not left waiting forever", async () => {
  const { client, rows } = await makeStandardRun(["vanished"]);
  try {
    const { client: api } = fakeClient({ get: () => ({ status_code: 20000, tasks: [{ status_code: 40401, status_message: "Task Not Found.", result: null }] }) });
    await submitDueRows(api);
    await collectFinished(api);
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } });
    assert.equal(row.status, "ERROR_RETRY");
    assert.equal((await prisma.dataforseoTask.findFirstOrThrow({ where: { rankingRowId: row.id } })).status, "ABANDONED");
  } finally {
    await cleanup(client.id);
  }
});

test("queue: a task still queued after 3 hours is given up and the row retried", async () => {
  const { client, rows } = await makeStandardRun(["stuck"]);
  try {
    const { client: api } = fakeClient({ get: () => ({ status_code: 20000, tasks: [{ status_code: 40602, status_message: "Task In Queue.", result: null }] }) });
    await submitDueRows(api);
    await collectFinished(api);
    assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } })).status, "PROCESSING", "queued = keep waiting");
    await collectFinished(api, { now: later(LOST_AFTER_MS + 60_000) });
    assert.equal((await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } })).status, "ERROR_RETRY");
  } finally {
    await cleanup(client.id);
  }
});

test("queue: results arriving for a cancelled run are not applied", async () => {
  const { client, run, rows } = await makeStandardRun(["cancel me"]);
  try {
    const { client: api } = fakeClient({});
    await submitDueRows(api);
    await cancelRun(run.id);
    await collectFinished(api);
    const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id }, include: { attempts: true } });
    assert.equal(row.attempts.length, 0);
    assert.equal(row.rankValue, null);
    assert.notEqual(row.status, "PROCESSING");
    assert.equal((await prisma.dataforseoTask.findFirstOrThrow({ where: { rankingRowId: row.id } })).status, "ABANDONED");
  } finally {
    await cleanup(client.id);
  }
});

test("restart: searches waiting at DataForSEO survive; half-done states are repaired; Live recovery leaves standard runs alone", async () => {
  const { client, run, rows } = await makeStandardRun(["waiting", "posting", "collecting", "orphan"]);
  try {
    const { client: api } = fakeClient({});
    await submitDueRows(api);
    const tasks = await prisma.dataforseoTask.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    const byRow = new Map(tasks.map((t) => [t.rankingRowId, t]));
    // Simulate a crash: one post never confirmed, one collection cut off, one row dequeued but never posted.
    await prisma.dataforseoTask.update({ where: { id: byRow.get(rows[1].id)!.id }, data: { status: "POSTING", dataforseoTaskId: null } });
    await prisma.dataforseoTask.update({ where: { id: byRow.get(rows[2].id)!.id }, data: { status: "COLLECTING" } });
    await prisma.dataforseoTask.delete({ where: { id: byRow.get(rows[3].id)!.id } });

    await recoverStaleProcessingRows(async () => ({ transportError: new Error("Live must not be called for a standard run") }), { onlyClientId: client.id });
    assert.equal((await prisma.rankingRow.findMany({ where: { runId: run.id, status: "PROCESSING" } })).length, 4, "Live recovery didn't touch them");

    await recoverStandardTasksOnStartup();
    const after = await Promise.all(rows.map((r) => prisma.rankingRow.findUniqueOrThrow({ where: { id: r.id } })));
    assert.equal(after[0].status, "PROCESSING", "still waiting at DataForSEO -- left alone");
    assert.equal(after[1].status, "PENDING", "unconfirmed post: row back in line, retry budget untouched");
    assert.equal(after[1].retryCount, 0);
    assert.equal(after[2].status, "PROCESSING");
    assert.equal((await prisma.dataforseoTask.findUniqueOrThrow({ where: { id: byRow.get(rows[2].id)!.id } })).status, "SUBMITTED", "collection resumes");
    assert.equal((await prisma.dataforseoTask.findUniqueOrThrow({ where: { id: byRow.get(rows[1].id)!.id } })).status, "ABANDONED");
    assert.equal(after[3].status, "PENDING", "dequeued but never posted: back in line");

    // ...and the run then finishes normally.
    await submitDueRows(api);
    await collectFinished(api);
    assert.equal((await prisma.rankingRow.findMany({ where: { runId: run.id, status: "COMPLETED" } })).length, 4);
  } finally {
    await cleanup(client.id);
  }
});

test("queue: Live runs are never picked up by the Standard queue", async () => {
  const { client, run } = await makeStandardRun(["live row"]);
  try {
    await prisma.rankingRun.update({ where: { id: run.id }, data: { engine: "live" } });
    const { client: api, calls } = fakeClient({});
    assert.equal(await submitDueRows(api), 0);
    assert.equal(calls.post, 0);
    assert.equal(await collectFinished(api), 0);
  } finally {
    await cleanup(client.id);
  }
});

test("engine switch: only workspaces listed in DATAFORSEO_STANDARD_WORKSPACES use Standard; the choice is saved on the run", async () => {
  const slug = `std-test-${randomUUID().slice(0, 8)}`;
  const workspace = await prisma.workspace.create({ data: { slug, name: "Standard test" } });
  const { client, run } = await makeStandardRun(["switch"], { status: "UPLOADED" });
  const before = process.env.DATAFORSEO_STANDARD_WORKSPACES;
  try {
    await prisma.client.update({ where: { id: client.id }, data: { workspaceId: workspace.id } });
    delete process.env.DATAFORSEO_STANDARD_WORKSPACES;
    assert.equal(await assignEngine(run.id), "live", "Live stays the default");
    process.env.DATAFORSEO_STANDARD_WORKSPACES = `seo, ${slug}`;
    assert.equal(await assignEngine(run.id), "standard");
    assert.equal((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).engine, "standard");
  } finally {
    if (before === undefined) delete process.env.DATAFORSEO_STANDARD_WORKSPACES;
    else process.env.DATAFORSEO_STANDARD_WORKSPACES = before;
    await cleanup(client.id);
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }
});

test("debug details: the numbers come out of the saved raw answers in the database (pages, organic results, redirect links)", async () => {
  const { client, run, rows } = await makeStandardRun(["kw"]);
  try {
    const raw = serp([
      { rank: 1, url: "https://google.com.au/goto?url=A" },
      { rank: 2, url: "https://www.client-site.com/" },
      { rank: 2, url: "https://ads.example.com/", type: "paid" },
    ], { pagesCount: 7 });
    const a = await prisma.rankingRowAttempt.create({
      data: { rankingRowId: rows[0].id, attemptNumber: 1, requestPayload: {}, dataforseoStatusCode: 20000, rawResponse: raw, outcome: "SUCCESS", mappedRankValue: 2, mappedRankingUrl: "https://www.client-site.com/" },
    });
    await prisma.rankingRow.update({ where: { id: rows[0].id }, data: { status: "COMPLETED", rankDisplay: "2", rankingUrl: "https://www.client-site.com/", lastAttemptId: a.id } });
    const d = await diagnoseRun(run.id);
    assert.equal(d.engine, "standard");
    assert.deepEqual(d.rows[0].attempts.map((t) => [t.statusCode, t.pages, t.organic, t.redirects]), [[20000, 7, 2, 1]], "the paid ad isn't counted");
    assert.equal(d.summary.redirects, 1);
    assert.equal(d.summary.organic, 2);
    assert.equal(d.rows[0].otherSite, false);
  } finally {
    await cleanup(client.id);
  }
});

test("queue: another website matching the wildcard target is skipped -- the client's own rank counts (too-high fix)", () => {
  const payload = buildStandardTask(
    { keyword: "concrete trowel", targetUrl: "*client-site.*", fullUrl: "client-site.com.au", locationName: "Australia", seDomain: "google.com.au", languageName: "English" },
    "row-1",
    1,
  );
  assert.deepEqual(payload.stop_crawl_on_match, [{ match_type: "with_subdomains", match_value: "client-site.com.au" }], "the queue task carries the client's domain");
  const body = serp([
    { rank: 3, url: "https://client-site-tools.com/trowel" },
    { rank: 61, url: "https://www.google.com.au/goto?url=x", breadcrumb: "https://www.client-site.com.au › trowels" },
  ]);
  const mapped = mapDataForSeoResponse({ body: applyTargetFilter(body, "*client-site.*"), requestPayload: payload });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 61);
  assert.equal(mapped.rankingUrl, "https://www.client-site.com.au/trowels");
});

// ---------------------------------------------------------------- several readings (median)

test("readings: DATAFORSEO_READINGS is 1-5 (default 1); the middle rank is picked, 'Not in 100' counted last", () => {
  assert.equal(standardReadings({}), 1);
  assert.equal(standardReadings({ DATAFORSEO_READINGS: "3" }), 3);
  assert.equal(standardReadings({ DATAFORSEO_READINGS: "9" }), 5);
  assert.equal(standardReadings({ DATAFORSEO_READINGS: "x" }), 1);
  const r = (readingRank: number | null) => ({ readingRank });
  assert.equal(pickMedianReading([r(7), r(86), r(2)]).readingRank, 7);
  assert.equal(pickMedianReading([r(null), r(3), r(5)]).readingRank, 5, "Not in 100 sorts last");
  assert.equal(pickMedianReading([r(5), r(9)]).readingRank, 9, "even count: the worse of the two middle ones");
  assert.equal(pickMedianReading([r(4)]).readingRank, 4);
});

async function withReadings<T>(n: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATAFORSEO_READINGS;
  process.env.DATAFORSEO_READINGS = n;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATAFORSEO_READINGS;
    else process.env.DATAFORSEO_READINGS = prev;
  }
}

/** A fake API whose readings of each keyword answer in turn from `answers` (a rank, null = not found, or a status code >= 40000). */
function readingsClient(answers: Record<string, (number | null)[]>) {
  const seen: Record<string, number> = {};
  return fakeClient({
    get: (_id, task) => {
      const i = (seen[task.keyword] = (seen[task.keyword] ?? 0) + 1) - 1;
      const a = answers[task.keyword][i];
      if (a !== null && a >= 40000) return serp([], { statusCode: a });
      return serp(a === null ? [{ rank: 1, url: "https://competitor.com/" }] : [{ rank: a, url: "https://www.client-site.com/services/" }]);
    },
  });
}

test("readings: 3 tasks per keyword in one batch; when all are in, the middle rank is applied once and the readings are kept", async () => {
  const { client, run, rows } = await makeStandardRun(["it managed services sydney", "biryani in thane"]);
  try {
    await withReadings("3", async () => {
      const { client: api, calls } = readingsClient({ "it managed services sydney": [7, 86, 2], "biryani in thane": [7, null, 6] });
      assert.equal(await submitDueRows(api), 6, "3 readings x 2 keywords");
      assert.equal(calls.post, 1, "all in one task_post");
      const tasks = await prisma.dataforseoTask.findMany({ where: { runId: run.id } });
      assert.equal(new Set(tasks.filter((t) => t.rankingRowId === rows[0].id).map((t) => t.groupId)).size, 1, "one group per keyword");
      assert.deepEqual(tasks.filter((t) => t.rankingRowId === rows[0].id).map((t) => t.reading).sort(), [1, 2, 3]);

      await collectFinished(api);

      const a = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id }, include: { attempts: true } });
      assert.equal(a.status, "COMPLETED");
      assert.equal(a.rankValue, 7, "middle of 2, 7, 86");
      assert.equal(a.attempts.length, 1, "ONE attempt for the three readings");
      assert.deepEqual((a.readings as { ranks: string[] }).ranks, ["7", "86", "2"]);
      const b = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[1].id } });
      assert.equal(b.rankValue, 7, "middle of 6, 7, Not in 100");
      const after = await prisma.dataforseoTask.findMany({ where: { runId: run.id } });
      assert.ok(after.every((t) => t.status === "COLLECTED" && t.finalizedAt && t.resultBody === null), "raw answers emptied once used");
      assert.match((await prisma.rankingRun.findUniqueOrThrow({ where: { id: run.id } })).status, /^COMPLETED/);
    });
  } finally {
    await cleanup(client.id);
  }
});

test("readings: a failed reading is left out; if every reading fails the row is retried like a single failed try", async () => {
  const { client, rows } = await makeStandardRun(["one error", "all errors"]);
  try {
    await withReadings("3", async () => {
      const { client: api } = readingsClient({ "one error": [5, 50401, 9], "all errors": [50401, 50401, 50401] });
      await submitDueRows(api);
      await collectFinished(api);
      const a = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id } });
      assert.equal(a.rankValue, 9, "middle of the 2 good readings (the worse one)");
      assert.deepEqual((a.readings as { ranks: string[] }).ranks, ["5", "error", "9"]);
      const b = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[1].id }, include: { attempts: true } });
      assert.equal(b.status, "ERROR_RETRY");
      assert.equal(b.attempts.length, 1, "one failed try, not three");
    });
  } finally {
    await cleanup(client.id);
  }
});

test("readings: two collectors finishing the last readings at once apply the median exactly once", async () => {
  const { client, rows } = await makeStandardRun(["race"]);
  try {
    await withReadings("3", async () => {
      const { client: api } = readingsClient({ race: [3, 4, 5, 3, 4, 5] });
      await submitDueRows(api);
      await Promise.all([collectFinished(api), collectFinished(api)]);
      const row = await prisma.rankingRow.findUniqueOrThrow({ where: { id: rows[0].id }, include: { attempts: true } });
      assert.equal(row.attempts.length, 1);
      assert.equal(row.status, "COMPLETED");
    });
  } finally {
    await cleanup(client.id);
  }
});
