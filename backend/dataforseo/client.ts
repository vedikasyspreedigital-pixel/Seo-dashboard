// Real DataForSEO HTTP call, extracted verbatim from scripts/run-real-batch.mjs
// -- no mapping/business logic here, just the network call. Only used when
// DATAFORSEO_LIVE=true (see backend/server.ts); dev/test default to the mock client.

export interface DataForSeoRequestPayload {
  keyword: string;
  target: string;
  location_name: string;
  se_domain: string;
  language_name: string;
  device: string;
  os: string;
  depth: number;
  stop_crawl_on_match?: { match_type: string; match_value: string }[];
  find_targets_in?: string[];
}

export interface DataForSeoCallResult {
  httpStatus?: number;
  body?: unknown;
  transportError?: Error;
}

// Live Regular, not Advanced: identical target/depth/pagination behavior for
// our purposes, but a narrower items[] extraction (organic/paid/featured_snippet
// only) that isn't exposed to Advanced's parsing of richer SERP features
// (images, local packs, etc). See the 40102 investigation -- switched after
// finding a real case where Advanced's crawl returned a truncated page count
// on a SERP with an image carousel. Exported so it can be verified from
// outside this module (e.g. the health endpoint) rather than just asserted.
export const LIVE_ENDPOINT_URL = "https://api.dataforseo.com/v3/serp/google/organic/live/regular";

// DataForSEO's own guidance for Live SERP calls is a 120-second client
// timeout "to prevent the request from being prematurely terminated"
// (dataforseo.com/help-center/best-practices-live-endpoints-in-dataforseo-api);
// +10s covers network/TLS overhead on top of their server-side budget.
//
// Was 60s, which was killing legitimate slow crawls: stored production data
// (runs since 2026-09-21) showed 178 Advanced SEO calls with no response at
// all, 42 rows failing on it after all 3 tries, and the slowest SUCCESSFUL
// Advanced SEO call at 59.6s -- the distribution was being cut off exactly
// at our limit (SEO calls are faster: p95 31s vs 51.5s, 0 cut off).
//
// A timeout is still required: without one, a hung call blocks forever --
// plain fetch has no default -- stalling processRun's sequential loop on
// that row permanently (found via a real stuck run). An abort still lands in
// the transportError path below: retried, never a rank or "Not in 100".
export const DATAFORSEO_REQUEST_TIMEOUT_MS = 130_000;

export async function callDataForSeoLive(
  requestPayload: DataForSeoRequestPayload,
  // Injectable for tests only -- production always uses the real fetch and the timeout above.
  { fetchImpl = fetch, timeoutMs = DATAFORSEO_REQUEST_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DataForSeoCallResult> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error(
      "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set (see serp-interpreter/.env)",
    );
  }
  const authHeader =
    "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

  try {
    const response = await fetchImpl(
      LIVE_ENDPOINT_URL,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const body = await response.json();
    return { httpStatus: response.status, body };
  } catch (transportError) {
    // An abort (timeout) lands here too, as a real Error -- the existing
    // transportError path already treats it like any other network failure,
    // which recordAttemptAndApply/mapResponse.js's retry classification
    // handles the same way a connection drop would: retried like a 50000+
    // transient error, not treated as a permanent failure.
    return { transportError: transportError as Error };
  }
}
