import type {
  DataForSeoCallResult,
  DataForSeoRequestPayload,
} from "./client.js";

// Deterministic per-keyword mock -- same keyword always gets the same
// simulated outcome, so a demo/dev run is reproducible without ever
// touching the real DataForSEO API. Used by default (see backend/server.ts);
// real calls require explicitly setting DATAFORSEO_LIVE=true.

function pseudoRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash / 0xffffffff;
}

function successBody(keyword: string, rankGroup: number, url: string) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [
          {
            keyword,
            items: [
              {
                type: "organic",
                rank_group: rankGroup,
                rank_absolute: rankGroup + 1,
                domain: url.replace(/^https?:\/\//, "").split("/")[0],
                title: `Mock result for "${keyword}"`,
                url,
              },
            ],
          },
        ],
      },
    ],
  };
}

function notFoundBody(keyword: string) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [{ keyword, items: [] }],
      },
    ],
  };
}

export function createMockDataForSeoClient({
  delayMs = [300, 800] as [number, number],
} = {}): (payload: DataForSeoRequestPayload) => Promise<DataForSeoCallResult> {
  return async function mockCallDataForSeo(payload) {
    const [min, max] = delayMs;
    await new Promise((resolve) =>
      setTimeout(resolve, min + Math.random() * (max - min)),
    );

    const r = pseudoRandom(payload.keyword);
    const domain = payload.target.replace(/\*/g, "");

    if (r < 0.15) {
      return { httpStatus: 200, body: notFoundBody(payload.keyword) };
    }

    const rank = Math.max(1, Math.round(r * 100));
    return {
      httpStatus: 200,
      body: successBody(payload.keyword, rank, `https://${domain}/`),
    };
  };
}
