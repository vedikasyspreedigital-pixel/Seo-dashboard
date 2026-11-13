import { randomUUID } from "node:crypto";
import type { DataForSeoCallResult, DataForSeoRequestPayload } from "./client.js";

/**
 * Serper.dev as the rank source (2026-11-13). DataForSEO confirmed that its Google pages are "poisoned" (Google
 * serves its crawlers fake result pages) with no fix date, and advised pausing Google Organic collection. On the
 * same 10 keywords checked by hand in incognito, Serper matched 4/10 within 3 places and found the client on 8/10;
 * DataForSEO matched 1/10 and missed 5 completely.
 *
 * RANK_PROVIDER=serper (with DATAFORSEO_LIVE=true and SERPER_API_KEY) swaps the Live call for this one. It takes the
 * SAME request the run would send DataForSEO and answers in DataForSEO's shape, so everything after it -- local
 * matching (targetMatch.js / mapResponse.js), retries, saved raw answers, Debug details, reports -- is unchanged.
 *
 * Google no longer returns 100 results per request (num=100 gives ~10), so up to 10 pages of 10 are fetched, one
 * Serper credit each, stopping at the page where the client's site appears (its Full URL domain, like DataForSEO's
 * stop_crawl_on_match). A keyword the client isn't in costs 10 credits.
 */

export const SERPER_URL = "https://google.serper.dev/search";
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;

export function serperSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RANK_PROVIDER?.trim().toLowerCase() === "serper";
}

export function hasSerperKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.SERPER_API_KEY?.trim();
}

export const MISSING_SERPER_KEY_MESSAGE = "Rank checks use Serper (RANK_PROVIDER=serper), but SERPER_API_KEY isn't set on the server.";

/** Google domain -> Serper's country code ("google.com.au" -> "au"; "google.com" -> "us"). */
export function glOf(seDomain: string | undefined): string {
  const host = String(seDomain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (!host || host === "google.com") return "us";
  const tld = host.split(".").pop() ?? "us";
  return tld === "uk" ? "gb" : tld;
}

const LANGUAGES: Record<string, string> = { english: "en", hindi: "hi", arabic: "ar", french: "fr", german: "de", spanish: "es" };
export function hlOf(languageName: string | undefined): string {
  return LANGUAGES[String(languageName ?? "").trim().toLowerCase()] ?? "en";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isClientSite(url: string, domain: string | null): boolean {
  if (!domain) return false;
  const h = hostOf(url);
  const d = domain.toLowerCase().replace(/^www\./, "");
  return h === d || h.endsWith(`.${d}`);
}

interface SerperOrganic {
  title?: string;
  link?: string;
  displayedLink?: string;
  snippet?: string;
  position?: number;
}

export function createSerperCall({ fetchImpl = fetch, env = process.env }: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  return async function callSerper(payload: DataForSeoRequestPayload): Promise<DataForSeoCallResult> {
    const key = env.SERPER_API_KEY?.trim();
    if (!key) return { transportError: new Error(MISSING_SERPER_KEY_MESSAGE) };
    const p = payload as DataForSeoRequestPayload & {
      keyword: string;
      location_name?: string;
      se_domain?: string;
      language_name?: string;
      stop_crawl_on_match?: { match_value: string }[];
    };
    const clientDomain = p.stop_crawl_on_match?.[0]?.match_value ?? null;
    const gl = glOf(p.se_domain);
    const hl = hlOf(p.language_name);
    const items: Record<string, unknown>[] = [];
    let pages = 0;
    let reachedEnd = false;
    let credits = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let res: Response;
      try {
        res = await fetchImpl(SERPER_URL, {
          method: "POST",
          headers: { "X-API-KEY": key, "Content-Type": "application/json" },
          body: JSON.stringify({ q: p.keyword, gl, hl, ...(p.location_name ? { location: p.location_name } : {}), num: 10, page }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        return { transportError: new Error(`Serper request failed on page ${page}: ${(err as Error).message}`) };
      }
      const body = (await res.json().catch(() => ({}))) as { organic?: SerperOrganic[]; credits?: number; message?: string };
      if (!res.ok) {
        // 401/403 = bad key or no credits left; 429 = too fast; 5xx = Serper down. Retried like a DataForSEO error.
        return { transportError: new Error(`Serper answered ${res.status} on page ${page}${body.message ? `: ${body.message}` : ""}`) };
      }
      credits += body.credits ?? 1;
      pages = page;
      const organic = (body.organic ?? []).filter((o) => typeof o.link === "string" && o.link);
      for (const o of organic) {
        items.push({
          type: "organic",
          rank_group: items.length + 1,
          rank_absolute: items.length + 1,
          page,
          url: o.link,
          domain: hostOf(o.link!),
          title: o.title ?? null,
          description: o.snippet ?? null,
          breadcrumb: o.displayedLink ?? null,
        });
      }
      if (organic.length === 0) {
        reachedEnd = true; // Google has no more results: the whole list was read
        break;
      }
      if (organic.some((o) => isClientSite(o.link!, clientDomain))) break; // found: no need to read further pages
    }

    const found = items.some((i) => isClientSite(String(i.url), clientDomain));
    const checkUrl = `https://www.${String(p.se_domain ?? "google.com").replace(/^www\./, "")}/search?q=${encodeURIComponent(p.keyword)}&hl=${hl}&gl=${gl.toUpperCase()}`;
    return {
      httpStatus: 200,
      body: {
        status_code: 20000,
        status_message: "Ok.",
        provider: "serper",
        credits,
        tasks: [
          {
            id: `serper-${randomUUID()}`,
            status_code: 20000,
            status_message: "Ok.",
            data: { ...payload, provider: "serper" },
            result: [
              {
                keyword: p.keyword,
                se_domain: p.se_domain,
                location_name: p.location_name,
                language_name: p.language_name,
                check_url: checkUrl,
                // A full read (10 pages, or Google ran out of results) is what lets "Not in 100" be trusted.
                pages_count: found ? pages : reachedEnd ? MAX_PAGES : pages,
                se_results_count: null,
                items_count: items.length,
                items,
              },
            ],
          },
        ],
      },
    };
  };
}
