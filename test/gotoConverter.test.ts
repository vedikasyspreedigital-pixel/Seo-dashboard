import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyResolvedLinks,
  createGotoConverter,
  gotoLinksIn,
  resolveGotoLinks,
  standardClientWithGotoResolution,
  unwrapCall,
  withGotoResolution,
} from "../backend/dataforseo/gotoConverter.js";
import { applyTargetFilter } from "../backend/dataforseo/targetMatch.js";
import { mapDataForSeoResponse } from "../backend/dataforseo/mapResponse.js";

// DataForSEO's free GoTo URL converter (2026-11-06): Google redirect links become real URLs before matching.

const G1 = "https://google.com.au/goto?url=CAESaQH1";
const G2 = "https://google.com.au/goto?url=CAESWAH2&gsessionid=x";
const G3 = "https://google.com.au/goto?url=CAESunresolved";

function serp() {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [
          {
            pages_count: 10,
            se_results_count: 1360,
            items: [
              { type: "organic", rank_group: 1, url: G1, domain: "google.com.au", breadcrumb: "https://www.other.com.au › page" },
              { type: "organic", rank_group: 2, url: "https://www.direct.com/", domain: "www.direct.com" },
              { type: "organic", rank_group: 3, url: G2, domain: "google.com.au", breadcrumb: "Client Studio" },
              { type: "organic", rank_group: 4, url: G3, domain: "google.com.au", breadcrumb: "https://www.client.com.au › contact" },
            ],
          },
        ],
      },
    ],
  };
}

const fakeConverter = async (links: string[]) => {
  const known: Record<string, string> = { [G1]: "https://www.other.com.au/page", [G2]: "https://www.client.com.au/services/" };
  return new Map(links.filter((l) => known[l]).map((l) => [l, known[l]]));
};

test("gotoLinksIn finds every redirect link once", () => {
  assert.deepEqual(gotoLinksIn(serp()).sort(), [G1, G2, G3].sort());
  assert.deepEqual(gotoLinksIn({ tasks: [{ result: null }] }), []);
});

test("resolveGotoLinks: converted items get the real url + domain, keep the redirect in google_url; others untouched", async () => {
  const original = serp();
  const resolved = (await resolveGotoLinks(original, fakeConverter)) as ReturnType<typeof serp>;
  const items = resolved.tasks[0].result[0].items as Record<string, unknown>[];
  assert.equal(items[0].url, "https://www.other.com.au/page");
  assert.equal(items[0].domain, "www.other.com.au");
  assert.equal(items[0].google_url, G1);
  assert.equal(items[0].url_source, "goto_converter");
  assert.equal(items[1].url, "https://www.direct.com/", "a real URL is left alone");
  assert.equal(items[1].google_url, undefined);
  assert.equal(items[3].url, G3, "a link the converter couldn't resolve stays a redirect (breadcrumb fallback later)");
  assert.equal(resolved.tasks[0].result[0].se_results_count, 1360, "everything else is kept");
  assert.equal(original.tasks[0].result[0].items[0].url, G1, "the input isn't changed");
});

test("the client's result hidden behind a redirect WITHOUT a usable breadcrumb is now found", async () => {
  const payload = { depth: 100, stop_crawl_on_match: [{ match_type: "with_subdomains", match_value: "client.com.au" }] };
  // Before: item 3's breadcrumb ("Client Studio") says nothing, so only item 4 (breadcrumb) matches -> rank 4.
  const before = mapDataForSeoResponse({ httpStatus: 200, body: applyTargetFilter(serp(), "*client.com.au*"), requestPayload: payload });
  assert.equal(before.rankValue, 4);
  // After conversion item 3 is https://www.client.com.au/services/ -> rank 3, the real one.
  const after = mapDataForSeoResponse({ httpStatus: 200, body: applyTargetFilter(await resolveGotoLinks(serp(), fakeConverter), "*client.com.au*"), requestPayload: payload });
  assert.equal(after.rankValue, 3);
  assert.equal(after.rankingUrl, "https://www.client.com.au/services/");
});

test("a converter failure never fails the search: the response comes back unchanged", async () => {
  const original = serp();
  const out = await resolveGotoLinks(original, async () => {
    throw new Error("converter down");
  });
  assert.equal(out, original);
});

test("no redirect links -> the converter isn't called", async () => {
  let called = false;
  const body = { tasks: [{ result: [{ items: [{ type: "organic", url: "https://a.com/" }] }] }] };
  assert.equal(await resolveGotoLinks(body, async () => ((called = true), new Map())), body);
  assert.equal(called, false);
});

test("withGotoResolution: resolves answers, passes transport errors through, and unwraps to the real call", async () => {
  const live = async () => ({ httpStatus: 200, body: serp() });
  const wrapped = withGotoResolution(live, fakeConverter);
  const res = await wrapped({});
  assert.equal((res.body as ReturnType<typeof serp>).tasks[0].result[0].items[0].url, "https://www.other.com.au/page");
  const failing = withGotoResolution(async () => ({ transportError: new Error("timeout") }), fakeConverter);
  assert.equal((await failing({})).transportError?.message, "timeout");
  assert.equal(unwrapCall(wrapped), live, "runs.ts can still tell it's the real Live call");
  assert.equal(unwrapCall(live), live);
});

test("standardClientWithGotoResolution resolves only the collected results", async () => {
  const client = {
    postTasks: async () => ({ httpStatus: 200, body: { posted: true } }),
    tasksReady: async () => ({ httpStatus: 200, body: { ready: true } }),
    taskGet: async () => ({ httpStatus: 200, body: serp() }),
  };
  const wrapped = standardClientWithGotoResolution(client, fakeConverter);
  assert.deepEqual((await wrapped.postTasks([])).body, { posted: true });
  const got = await wrapped.taskGet("id");
  assert.equal((got.body as ReturnType<typeof serp>).tasks[0].result[0].items[2].url, "https://www.client.com.au/services/");
});

test("createGotoConverter: sends the links in DataForSEO's format and reads {goto, url} pairs", async () => {
  const prev = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
  process.env.DATAFORSEO_LOGIN = "login";
  process.env.DATAFORSEO_PASSWORD = "pw";
  try {
    let sent: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ tasks: [{ status_code: 20000, cost: 0, result: [{ goto: G1, url: "https://www.other.com.au/page" }, { goto: G2, url: G2 }] }] }));
    }) as typeof fetch;
    const out = await createGotoConverter({ fetchImpl })([G1, G2]);
    assert.deepEqual(sent, [{ goto_urls: [G1, G2] }]);
    assert.equal(out.get(G1), "https://www.other.com.au/page");
    assert.equal(out.has(G2), false, "an answer that is still a redirect isn't used");
  } finally {
    process.env.DATAFORSEO_LOGIN = prev.l;
    process.env.DATAFORSEO_PASSWORD = prev.p;
    if (prev.l === undefined) delete process.env.DATAFORSEO_LOGIN;
    if (prev.p === undefined) delete process.env.DATAFORSEO_PASSWORD;
  }
});

test("applyResolvedLinks with nothing resolved returns the same object", () => {
  const body = serp();
  assert.equal(applyResolvedLinks(body, new Map()), body);
});
