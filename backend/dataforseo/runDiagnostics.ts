import { prisma } from "../db/client.js";
import { normalizeMatchDomain } from "./buildRequest.js";
import { isGoogleRedirect } from "./targetMatch.js";

// The run's "Debug details" (tech lead's request, 2026-11-05: "add a debugger to that API to see what results
// in this error code"). Built from what every attempt already saves -- DataForSEO's status code and its full
// raw answer (kept 40 days, pruneRawResponses.ts) -- so it works for past runs too, Live and Standard alike.
// Per keyword: every try's status code, how many result pages DataForSEO crawled, how many results were
// Google redirect links (the client's address hidden), and the URL that was counted as the client -- flagged
// when it isn't the client's own website (a wildcard target like "*site.*" also matches other sites).

/** What DataForSEO's status codes mean, in the team's words (docs.dataforseo.com/v3/appendix/errors). */
export const STATUS_CODE_MEANINGS: Record<number, string> = {
  20000: "OK",
  40101: "Google's server errored (retried)",
  40102: "No results -- trusted only if all ~10 pages were crawled",
  40103: "Task failed (retried)",
  40106: "Partial results (retried)",
  40202: "Rate limit (retried)",
  40401: "Task not found",
  40501: "Invalid field in the request (bad location/URL)",
  50000: "DataForSEO internal error (retried)",
  50401: "DataForSEO internal timeout (retried)",
};

/** A 40102 "no results" from fewer pages than this isn't trusted (mapResponse.js: depth 100 = 10 pages, 1 short allowed). */
const FULL_CRAWL_PAGES = 9;

interface AttemptRow {
  ranking_row_id: string;
  attempt_number: number;
  dataforseo_status_code: number | null;
  outcome: string;
  error_message: string | null;
  mapped_rank_value: number | null;
  mapped_ranking_url: string | null;
  created_at: Date;
  pages: number | null;
  organic: number | null;
  redirects: number | null;
  converted?: number | null;
  raw_kept: boolean;
}

export interface AttemptDiagnosis {
  attempt: number;
  statusCode: number | null;
  outcome: string;
  /** Result pages DataForSEO crawled (10 = the full top 100). */
  pages: number | null;
  /** Organic results in the answer -- Live only returns the client's own (its `target` filter), Standard all of them. */
  organic: number | null;
  /** Of those, Google redirect links (address hidden). */
  redirects: number | null;
  error: string | null;
  at: string;
}

export interface RowDiagnosis {
  keyword: string;
  location: string;
  status: string;
  rank: string | null;
  rankingUrl: string | null;
  /** The client's website, from the row's Full URL (or its target pattern). */
  clientDomain: string | null;
  /** The counted URL isn't on the client's own website. */
  otherSite: boolean;
  attempts: AttemptDiagnosis[];
}

export interface RunDiagnostics {
  engine: string;
  rows: RowDiagnosis[];
  summary: {
    keywords: number;
    tries: number;
    /** Every try, by DataForSEO status code -- with the average pages crawled for that code. */
    byStatusCode: { code: number | null; meaning: string; tries: number; avgPages: number | null }[];
    /** 40102 "no results" answers that stopped before crawling all the pages (not trusted -> retried). */
    earlyStops: number;
    /** Keywords whose counted URL isn't on the client's own website. */
    otherSiteMatches: number;
    /** Google redirect links among the organic results DataForSEO returned (all tries). */
    redirects: number;
    /** Redirect links the free GoTo URL converter turned into real addresses (gotoConverter.ts). */
    converted: number;
    organic: number;
    /** Tries whose raw answer was already emptied (older than 40 days) -- no page/redirect numbers for them. */
    rawGone: number;
  };
}

/** The client's website for a row: its Full URL, else its target pattern without the wildcards. */
export function clientDomainOf(fullUrl: string | null, targetUrl: string): string | null {
  return normalizeMatchDomain(fullUrl) ?? normalizeMatchDomain(String(targetUrl ?? "").replace(/\*/g, "").replace(/^\.+|\.+$/g, ""));
}

/** Is `url` on the client's own website (the domain itself or one of its subdomains)? */
export function isOnClientSite(url: string, clientDomain: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return host === clientDomain || host.endsWith(`.${clientDomain}`);
}

export async function diagnoseRun(runId: string): Promise<RunDiagnostics> {
  const run = await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId }, select: { engine: true } });
  const rows = await prisma.rankingRow.findMany({
    where: { runId },
    orderBy: { sourceRowNumber: "asc" },
    select: { id: true, keyword: true, locationName: true, status: true, rankDisplay: true, rankingUrl: true, fullUrl: true, targetUrl: true },
  });
  // Only the numbers are read out of the raw answers, in the database -- a run's raw answers can be many MB.
  const attempts = await prisma.$queryRaw<AttemptRow[]>`
    SELECT a.ranking_row_id, a.attempt_number, a.dataforseo_status_code, a.outcome::text AS outcome, a.error_message,
           a.mapped_rank_value, a.mapped_ranking_url, a.created_at,
           (a.raw_response IS NOT NULL) AS raw_kept,
           (a.raw_response->'tasks'->0->'result'->0->>'pages_count')::int AS pages,
           (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(a.raw_response->'tasks'->0->'result'->0->'items', '[]'::jsonb)) i
             WHERE i->>'type' = 'organic') AS organic,
           (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(a.raw_response->'tasks'->0->'result'->0->'items', '[]'::jsonb)) i
             WHERE i->>'type' = 'organic' AND i->>'url' ~* '^https?://(www\\.)?google\\.[a-z.]+/(goto|url)\\?') AS redirects,
           (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(a.raw_response->'tasks'->0->'result'->0->'items', '[]'::jsonb)) i
             WHERE i->>'type' = 'organic' AND i ? 'google_url') AS converted
    FROM ranking_row_attempts a
    JOIN ranking_rows r ON r.id = a.ranking_row_id
    WHERE r.run_id = ${runId}
    ORDER BY a.attempt_number ASC, a.created_at ASC`;
  return buildDiagnostics(run.engine, rows, attempts);
}

/** The pure part (tests): rows + their tries -> the table and the summary. */
export function buildDiagnostics(
  engine: string,
  rows: { id: string; keyword: string; locationName: string; status: string; rankDisplay: string | null; rankingUrl: string | null; fullUrl: string | null; targetUrl: string }[],
  attempts: AttemptRow[],
): RunDiagnostics {
  const byRow = new Map<string, AttemptRow[]>();
  for (const a of attempts) byRow.set(a.ranking_row_id, [...(byRow.get(a.ranking_row_id) ?? []), a]);

  const codes = new Map<number | null, { tries: number; pagesSum: number; pagesN: number }>();
  let earlyStops = 0;
  let redirects = 0;
  let converted = 0;
  let organic = 0;
  let rawGone = 0;
  const out: RowDiagnosis[] = rows.map((row) => {
    const tries = byRow.get(row.id) ?? [];
    for (const t of tries) {
      const c = codes.get(t.dataforseo_status_code) ?? { tries: 0, pagesSum: 0, pagesN: 0 };
      c.tries++;
      if (t.pages != null) {
        c.pagesSum += t.pages;
        c.pagesN++;
      }
      codes.set(t.dataforseo_status_code, c);
      if (t.dataforseo_status_code === 40102 && t.pages != null && t.pages < FULL_CRAWL_PAGES) earlyStops++;
      if (!t.raw_kept) rawGone++;
      redirects += t.redirects ?? 0;
      converted += t.converted ?? 0;
      organic += t.organic ?? 0;
    }
    const clientDomain = clientDomainOf(row.fullUrl, row.targetUrl);
    const otherSite = !!(row.rankingUrl && clientDomain && !isGoogleRedirect(row.rankingUrl) && !isOnClientSite(row.rankingUrl, clientDomain));
    return {
      keyword: row.keyword,
      location: row.locationName,
      status: row.status,
      rank: row.rankDisplay,
      rankingUrl: row.rankingUrl,
      clientDomain,
      otherSite,
      attempts: tries.map((t) => ({
        attempt: t.attempt_number,
        statusCode: t.dataforseo_status_code,
        outcome: t.outcome,
        pages: t.raw_kept ? t.pages : null,
        organic: t.raw_kept ? t.organic : null,
        redirects: t.raw_kept ? t.redirects : null,
        error: t.error_message,
        at: new Date(t.created_at).toISOString(),
      })),
    };
  });

  return {
    engine,
    rows: out,
    summary: {
      keywords: rows.length,
      tries: attempts.length,
      byStatusCode: [...codes.entries()]
        .sort((a, b) => b[1].tries - a[1].tries)
        .map(([code, c]) => ({
          code,
          meaning: code == null ? "No answer (connection failed or timed out on our side)" : (STATUS_CODE_MEANINGS[code] ?? (code >= 50000 ? "DataForSEO server error (retried)" : "See DataForSEO's error list")),
          tries: c.tries,
          avgPages: c.pagesN ? Math.round((c.pagesSum / c.pagesN) * 10) / 10 : null,
        })),
      earlyStops,
      otherSiteMatches: out.filter((r) => r.otherSite).length,
      redirects,
      converted,
      organic,
      rawGone,
    },
  };
}
