import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerperCall, glOf, hlOf } from "../backend/dataforseo/serperClient.js";
import { buildLiveRequest } from "../backend/dataforseo/buildRequest.js";
import { applyTargetFilter } from "../backend/dataforseo/targetMatch.js";
import { mapDataForSeoResponse } from "../backend/dataforseo/mapResponse.js";

// Serper.dev as the rank source (RANK_PROVIDER=serper, 2026-11-13): answers in DataForSEO's shape, so the usual
// matching gives the rank.

const env = { SERPER_API_KEY: "test-key" } as NodeJS.ProcessEnv;
const row = { keyword: "it managed services sydney", targetUrl: "*trueitc.*", fullUrl: "https://www.trueitc.com.au", locationName: "Australia", seDomain: "google.com.au", languageName: "English" };

/** A fake Serper: page n answers 10 links; the client sits at overall position `clientAt` (or nowhere). */
function fakeSerper(clientAt: number | null, { lastPage = 10, failOn }: { lastPage?: number; failOn?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    if (body.page === failOn) return new Response(JSON.stringify({ message: "Not enough credits" }), { status: 403 });
    if (body.page > lastPage) return new Response(JSON.stringify({ organic: [], credits: 1 }));
    const organic = Array.from({ length: 10 }, (_, i) => {
      const pos = (body.page - 1) * 10 + i + 1;
      const link = pos === clientAt ? "https://www.trueitc.com.au/managed-it/" : `https://competitor${pos}.com.au/`;
      return { title: `r${pos}`, link, displayedLink: link, position: i + 1 };
    });
    return new Response(JSON.stringify({ organic, credits: 1 }));
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const rankOf = (body: unknown) => mapDataForSeoResponse({ httpStatus: 200, body: applyTargetFilter(body, row.targetUrl), requestPayload: buildLiveRequest(row) });

test("country and language from the run's row", () => {
  assert.equal(glOf("google.com.au"), "au");
  assert.equal(glOf("google.co.in"), "in");
  assert.equal(glOf("google.ae"), "ae");
  assert.equal(glOf("google.co.uk"), "gb");
  assert.equal(glOf("google.com"), "us");
  assert.equal(hlOf("English"), "en");
});

test("client on page 2 -> rank counted across pages; stops after that page (2 credits, not 10)", async () => {
  const { fetchImpl, sent } = fakeSerper(14);
  const res = await createSerperCall({ fetchImpl, env })(buildLiveRequest(row));
  assert.equal(sent.length, 2);
  assert.deepEqual({ q: sent[0].q, gl: sent[0].gl, hl: sent[0].hl, location: sent[0].location, page: sent[1].page }, { q: row.keyword, gl: "au", hl: "en", location: "Australia", page: 2 });
  const mapped = rankOf(res.body);
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankValue, 14);
  assert.equal(mapped.rankingUrl, "https://www.trueitc.com.au/managed-it/");
  assert.equal((res.body as { credits: number }).credits, 2);
});

test("client not in the top 100 -> all 10 pages read -> 'Not in 100' (trusted, full read)", async () => {
  const { fetchImpl, sent } = fakeSerper(null);
  const res = await createSerperCall({ fetchImpl, env })(buildLiveRequest(row));
  assert.equal(sent.length, 10);
  const mapped = rankOf(res.body);
  assert.equal(mapped.outcome, "SUCCESS");
  assert.equal(mapped.rankDisplay, "Not in 100");
});

test("Google runs out of results early -> still a full read; 'Not in 100'", async () => {
  const { fetchImpl, sent } = fakeSerper(null, { lastPage: 4 });
  const res = await createSerperCall({ fetchImpl, env })(buildLiveRequest(row));
  assert.equal(sent.length, 5, "pages 1-4 + the empty page 5");
  assert.equal(rankOf(res.body).rankDisplay, "Not in 100");
});

test("a Serper error (e.g. no credits left) is a failed try, retried like a DataForSEO error; no key -> clear message", async () => {
  const { fetchImpl } = fakeSerper(null, { failOn: 3 });
  const res = await createSerperCall({ fetchImpl, env })(buildLiveRequest(row));
  assert.match(res.transportError?.message ?? "", /Serper answered 403 on page 3: Not enough credits/);
  const noKey = await createSerperCall({ fetchImpl, env: {} as NodeJS.ProcessEnv })(buildLiveRequest(row));
  assert.match(noKey.transportError?.message ?? "", /SERPER_API_KEY/);
});
