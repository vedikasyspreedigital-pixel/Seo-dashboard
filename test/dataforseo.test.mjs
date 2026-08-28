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

function successBody(items) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [{ keyword: "cash for cars perth", items }],
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
  });
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

test('not found within depth 100: empty items array maps to "Not in 100"', () => {
  const mapped = mapDataForSeoResponse({
    httpStatus: 200,
    body: successBody([]),
  });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, null);
  assert.equal(mapped.rankDisplay, "Not in 100");
  assert.equal(mapped.rankingUrl, null);
});

test('task status 40102 "No Search Results" (items: null) -> SUCCESS, "Not in 100", not an error', () => {
  // Observed on a real DataForSEO response for a local/suburb-level keyword:
  // task-level status_code 40102 with result[0].items: null, instead of the
  // usual status_code 20000 + items: []. Both mean the same thing.
  const body = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 40102,
        status_message: "No Search Results.",
        result: [
          { keyword: "cash for cars rockingham", type: "organic", items: null },
        ],
      },
    ],
  };
  const mapped = mapDataForSeoResponse({ httpStatus: 200, body });
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.retryable, false);
  assert.equal(mapped.rankValue, null);
  assert.equal(mapped.rankDisplay, "Not in 100");
  assert.equal(mapped.rankingUrl, null);
  assert.equal(mapped.matchedItemCount, 0);
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
