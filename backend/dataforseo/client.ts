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

export async function callDataForSeoLive(
  requestPayload: DataForSeoRequestPayload,
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
    const response = await fetch(
      LIVE_ENDPOINT_URL,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      },
    );
    const body = await response.json();
    return { httpStatus: response.status, body };
  } catch (transportError) {
    return { transportError: transportError as Error };
  }
}
