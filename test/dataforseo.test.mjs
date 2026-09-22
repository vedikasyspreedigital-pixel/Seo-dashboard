import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";
import { mapDataForSeoResponse } from "../backend/dataforseo/mapResponse.js";

// Pure unit tests -- no DB, no network. Fixtures mirror the real DataForSEO
// Live Regular Organic response shape (organic items are identical in shape
// to Live Advanced; we only ever read type/rank_group/rank_absolute/url).

const CASH_FOR_CARS_ROW = {
  keyword: "cash for cars perth",
  targetUrl: "*cash-for-cars-perth.*",
  fullUrl: "cash-for-cars-perth.com.au",
  locationName: "Australia",
  seDomain: "google.com.au",
  languageName: "English",
};

function organicItem(overrides = {}) {
  return {
    type: "organic",
    rank_group: 8,
    rank_absolute: 9,
    page: 1,
    domain: "cash-for-cars-perth.com.au",
    title: "Cash For Cars Perth",
    description: "We buy cars for cash in Perth.",
    url: "https://www.cash-for-cars-perth.com.au/",
    breadcrumb: "cash-for-cars-perth.com.au",
    ...overrides,
  };
}

function successBody(items, pagesCount = 10) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        // pages_count defaults to a full-depth crawl (10 pages = depth 100) --
        // real responses always include this field; a match doesn't depend
        // on it, but the "not found" tests need it to prove the crawl
        // actually reached full depth before trusting "Not in 100".
        result: [{ keyword: "cash for cars perth", items, pages_count: pagesCount }],
      },
    ],
  };
}

test("buildDataForSeoRequest maps the locked cash-for-cars-perth row exactly", () => {
  const payload = buildDataForSeoRequest(CASH_FOR_CARS_ROW);
  assert.deepEqual(payload, {
    keyword: "cash for cars perth",
    target: "*cash-for-cars-perth.*", // verbatim wildcard, not normalized
    location_name: "Australia",
    se_domain: "google.com.au",
    language_name: "English",
    device: "desktop",
    os: "windows",
    depth: 100,
    // Verified live against the real DataForSEO API: match_type
    // "with_subdomains" + the real fullUrl domain (not the fuzzy wildcard
    // targetUrl, which DataForSEO rejects here) crawls the same full
    // depth=100 on a genuine non-match (confirmed pages_count=10, full
    // cost), and stops/refunds early on a genuine match (confirmed page 1,
    // ~1/8th cost, correct rank_group) -- a cost change, never accuracy.
    stop_crawl_on_match: [{ match_type: "with_subdomains", match_value: "cash-for-cars-perth.com.au" }],
    find_targets_in: ["organic"],
  });
});

test("buildDataForSeoRequest omits stop_crawl_on_match/find_targets_in entirely when fullUrl is empty (falls back to the exact prior behavior for that row)", () => {
  const payload = buildDataForSeoRequest({ ...CASH_FOR_CARS_ROW, fullUrl: null });
  assert.equal(payload.stop_crawl_on_match, undefined);
  assert.equal(payload.find_targets_in, undefined);
});

test("ranking found: single matching item maps to SUCCESS with rank_group and url", () => {
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody([organicItem()]),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 8);
  assert.equal(mapped.rankDisplay, "8");
  assert.equal(mapped.rankingUrl, "https://www.cash-for-cars-perth.com.au/");
  assert.equal(mapped.matchedItemCount, 1);
});

test("multiple matching URLs on the same domain: uses the first (best-ranked) item", () => {
  const items = [
    organicItem({
      rank_group: 6,
      url: "https://www.cash-for-cars-perth.com.au/quote",
    }),
    organicItem({
      rank_group: 21,
      url: "https://www.cash-for-cars-perth.com.au/blog/scrap-cars",
    }),
  ];
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody(items),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 6);
  assert.equal(
    mapped.rankingUrl,
    "https://www.cash-for-cars-perth.com.au/quote",
  );
  assert.equal(mapped.matchedItemCount, 2);
});

// Regression coverage for organic-only matching: DataForSEO's own docs
// describe items[] as potentially mixing organic, paid, and featured-snippet
// results (0 real occurrences found in production data so far, but nothing
// guarantees that stays true). A non-organic item ranked ABOVE the real
// organic result must never be picked as "best" -- only rank_group among
// organic items counts.
test("a non-organic item (e.g. a paid ad on the same domain) ranked first is skipped -- the organic match is used instead", () => {
  const items = [
    organicItem({ type: "paid", rank_group: 1, url: "https://www.cash-for-cars-perth.com.au/ad" }),
    organicItem({ rank_group: 8 }), // type: "organic" (the helper's default)
  ];
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody(items),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 8, "the paid item's rank_group=1 must never be reported as the ranking");
  assert.equal(mapped.rankingUrl, "https://www.cash-for-cars-perth.com.au/");
  assert.equal(mapped.matchedItemCount, 1, "matchedItemCount reflects organic items only");
});

test("items containing ONLY non-organic results (full-depth crawl) map to \"Not in 100\", not a match", () => {
  const items = [organicItem({ type: "paid", rank_group: 1 }), organicItem({ type: "featured_snippet", rank_group: 1 })];
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody(items),
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, null);
  assert.equal(mapped.rankDisplay, "Not in 100");
});

test("Task Completed with Partial Results (40106): a non-organic item is skipped, the organic match underneath it is used", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40106,
        status_message: "Task completed with partial results.",
        result: [{ items: [organicItem({ type: "paid", rank_group: 1 }), organicItem({ rank_group: 3 })] }],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 3);
});

test('not found within depth 100: empty items array (full-depth crawl) maps to "Not in 100"', () => {
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody([]),
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, null);
  assert.equal(mapped.rankDisplay, "Not in 100");
  assert.equal(mapped.rankingUrl, null);
});

// Regression test for the depth-coverage gap: status_code 40102 already had
// this guard (see the tests below), but the far more common status_code
// 20000 + items:[] "not found" path had none at all -- a shallow crawl on
// THIS path was confirmed as "Not in 100" outright, with no depth check
// whatsoever. 0 real occurrences of this exact shape were found in
// production data (every real "not found" response recorded used 40102
// instead), but nothing in DataForSEO's docs guarantees that stays true, so
// this path is now guarded identically to the 40102 one.
test('status_code 20000 + items:[] with a SHALLOW crawl (pages_count: 2 of ~10) -> retryable API_ERROR, NOT "Not in 100"', () => {
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody([], 2),
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.rankValue, null);
  assert.notEqual(mapped.rankDisplay, "Not in 100");
});

test("status_code 20000 + items:[] with no pages_count at all -> retryable API_ERROR (no completeness evidence to trust \"Not in 100\")", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items: [] }] }],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
});

test('task status 40102 "No Search Results" with a full-depth crawl (items: null, pages_count: 10) -> SUCCESS, "Not in 100", not an error', () => {
  // Observed on a real DataForSEO response for a local/suburb-level keyword:
  // task-level status_code 40102 with result[0].items: null, instead of the
  // usual status_code 20000 + items: []. Both mean the same thing -- as long
  // as pages_count shows the crawl actually reached the requested depth (see
  // the "insufficient depth coverage" tests below for when it doesn't).
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40102,
        status_message: "No Search Results.",
        result: [
          { keyword: "cash for cars rockingham", type: "organic", items: null, pages_count: 10 },
        ],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.rankValue, null);
  assert.equal(mapped.rankDisplay, "Not in 100");
  assert.equal(mapped.rankingUrl, null);
  assert.equal(mapped.matchedItemCount, 0);
});

// Regression tests for the false "Not in 100" bug found via real production
// data: the exact same keyword/target, run a day apart, came back 40102 with
// a shallow crawl (pages_count far short of the ~10 pages depth=100 implies)
// on one day, then found a real rank on a full-depth crawl the next.
test('task status 40102 with a shallow crawl (pages_count: 1 of ~10) -> retryable API_ERROR, NOT "Not in 100"', () => {
  // Modeled directly on the real response for "car steerio abu dhabi" /
  // emiratessound.com (2026-09-10): pages_count 1, written as "Not in 100"
  // by the old mapper, then found at rank 12 on a full-depth retry.
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40102,
        status_message: "No Search Results.",
        result: [{ keyword: "car steerio abu dhabi", type: "organic", items: null, pages_count: 1 }],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW), // depth: 100, same as the real row
  });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.rankValue, null);
  assert.notEqual(mapped.rankDisplay, "Not in 100");
});

test('task status 40102 with no pages_count at all -> retryable API_ERROR (no completeness evidence to trust "Not in 100")', () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40102, status_message: "No Search Results.", result: null }],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
});

test('task status 40102 with pages_count one short of full depth (9 of ~10) -> still SUCCESS, "Not in 100" (allowed shortfall)', () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      { status_code: 40102, status_message: "No Search Results.", result: [{ items: null, pages_count: 9 }] },
    ],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankDisplay, "Not in 100");
});

test("task-level non-retryable error (malformed post data, 40501) -> API_ERROR, not retryable", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40501, status_message: "Invalid Field Format." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.taskStatusCode, 40501);
});

test("task-level server error (50000) -> API_ERROR, retryable", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 50000, status_message: "Internal Error." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
});

test("top-level auth failure (40100), no tasks array at all -> API_ERROR, not retryable", () => {
  const body = {
    status_code: 40100,
    status_message: "Auth error. Invalid Login/Password.",
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.taskStatusCode, 40100);
});

test("rate limit (40202) is retryable despite being in the 40000s range", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40202, status_message: "Too Many Requests." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
});

// Regression tests for the retry-classification bug found via real
// production data: a run's 9 rows all failed permanently (FAILED, only 1
// attempt each) on task-level codes 40101/40106, then succeeded when the
// SAME request was manually resubmitted later -- direct proof these are
// transient, not permanent, contradicting the old blanket "40000-49999 =
// permanent" assumption. DataForSEO's own docs confirm both codes (plus
// 40103, same category, not yet seen in production but documented the
// same way) are meant to be retried.
test("Internal SE Server Error (40101) is retryable -- confirmed transient via production data + DataForSEO docs", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40101, status_message: "Internal SE Server Error." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.taskStatusCode, 40101);
});

test("Task Execution Failed (40103) is retryable per DataForSEO docs", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40103, status_message: "Task Execution Failed." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.taskStatusCode, 40103);
});

test("Task Completed with Partial Results (40106) with no items is still retryable -- confirmed transient via production data + DataForSEO docs", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40106, status_message: "Task completed with partial results." }],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.taskStatusCode, 40106);
});

// Regression test for the discarded-valid-match bug found via real
// production data: row "autopsy headrest australia" / pangalark.com.au got
// task status 40106 twice in a row, BOTH times with a confident rank_group=1
// match already present in items -- but the old mapper threw the match away
// unconditionally because it branched on status_code before ever looking at
// items, and the row ended up permanently FAILED once retries ran out.
test("Task Completed with Partial Results (40106) WITH a matching item -> accepted as SUCCESS with the matched rank_group/url", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40106,
        status_message:
          "Task completed with partial results. Some pages could not be retrieved after several retry attempts.",
        result: [
          {
            items: [
              organicItem({
                rank_group: 1,
                rank_absolute: 2,
                url: "https://www.pangalark.com.au/product/headrest-rubber-ba025/",
              }),
            ],
          },
        ],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.rankValue, 1);
  assert.equal(mapped.rankDisplay, "1");
  assert.equal(mapped.rankingUrl, "https://www.pangalark.com.au/product/headrest-rubber-ba025/");
});

test("Task Completed with Partial Results (40106) with an unusable item (missing rank_group) still falls back to retryable API_ERROR", () => {
  const badItem = organicItem();
  delete badItem.rank_group;
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40106,
        status_message: "Task completed with partial results.",
        result: [{ items: [badItem] }],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
});

test("No Search Results (40102) with a full-depth crawl is still SUCCESS/Not-in-100, untouched by the retryable-code fix", () => {
  // 40102 was deliberately kept OUT of RETRYABLE_STATUS_CODES by the original
  // retryable-code fix -- this still holds today, as long as the crawl
  // reached the requested depth (see the depth-coverage tests above for the
  // separate, later fix covering the shallow-crawl case).
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [{ status_code: 40102, status_message: "No Search Results.", result: [{ items: null, pages_count: 10 }] }],
  };
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body,
    requestPayload: buildDataForSeoRequest(CASH_FOR_CARS_ROW),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.rankValue, null);
});

test("transport/network failure (no response body) -> API_ERROR, retryable", () => {
  const mapped = mapDataForSeoResponse({
    transportError: new Error("ETIMEDOUT"),
  });
  assert.equal(mapped.outcome, "API_ERROR");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.errorMessage, "ETIMEDOUT");
});

test("malformed response: missing tasks[] entirely -> MAPPING_ERROR, retryable", () => {
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: { status_code: 20000, status_message: "Ok." },
  });
  assert.equal(mapped.outcome, "MAPPING_ERROR");
  assert.equal(mapped.retryable, true);
});

test("malformed response: result.items key missing (not just empty) -> MAPPING_ERROR", () => {
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      { status_code: 20000, status_message: "Ok.", result: [{ keyword: "x" }] },
    ],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "MAPPING_ERROR");
});

test("malformed response: matched item missing rank_group -> MAPPING_ERROR", () => {
  const badItem = organicItem();
  delete badItem.rank_group;
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody([badItem]),
  });
  assert.equal(mapped.outcome, "MAPPING_ERROR");
  assert.equal(mapped.matchedItemCount, 1);
});

test("malformed response: empty/non-object body -> MAPPING_ERROR", () => {
  assert.equal(
    mapDataForSeoResponse({ httpStatus: 200, body: null }).outcome,
    "MAPPING_ERROR",
  );
  assert.equal(
    mapDataForSeoResponse({ httpStatus: 200, body: "not json" }).outcome,
    "MAPPING_ERROR",
  );
  assert.equal(mapDataForSeoResponse({}).outcome, "MAPPING_ERROR");
});
