import { prisma } from "../db/client.js";
import { resultUrl } from "../reporting/baselineColumns.js";

/**
 * "Poisoned SERP" check (2026-11-12). Since 26 Sep 2026 Google sometimes answers scrapers with a normal-looking
 * results page whose organic results are mostly swapped for unrelated sites (DataForSEO blog "Poisoned SERPs",
 * 23 Oct 2026: 20-30% of pages at first, ~2-3% left after retries). A rank read off such a page is wrong -- the
 * team's manual checks showed the client at #1-#4 where we had "Not in 100".
 *
 * DataForSEO's own test: a page is poisoned when "fewer than half of the websites that usually appear for its
 * keyword appear anywhere on the page". "Usually appear" = the top-20 sites of the SAME keyword in the client's
 * previous run. So, per keyword, on Live:
 *   1. compare the answer with the previous run's top 20  -> half or more still there: OK, use it.
 *   2. otherwise ask DataForSEO once more (one extra Live call, ~$0.015) and compare that answer:
 *        matches the previous run      -> "ok_after_retry"  (the first page was poisoned)
 *        matches the FIRST answer      -> "changed"         (two readings agree: Google's page really changed)
 *        matches neither               -> "suspect"         (rank kept, but shown as unconfirmed)
 * No previous run (new client / new keyword / old answers emptied or saved before full SERPs) -> "no_previous".
 * DATAFORSEO_POISON_CHECK=0 turns it off.
 */

export const POISON_THRESHOLD = 0.5;
const PREVIOUS_TOP = 20;
/** Fewer known sites than this in a page = not enough to judge (e.g. an old target-filtered answer). */
const MIN_SITES = 8;

export type SerpCheckStatus = "ok" | "ok_after_retry" | "changed" | "suspect" | "no_previous";

export interface SerpCheck {
  status: SerpCheckStatus;
  /** Share of the previous run's top-20 sites found anywhere in the answer that was used. */
  share: number | null;
  /** Share for the first answer, when a second one was asked for. */
  firstShare?: number | null;
  /** The two answers' agreement, when a second one was asked for. */
  firstVsRetry?: number | null;
  retried: boolean;
  previousRunId?: string | null;
}

export function poisonCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Off for Serper: its pages aren't DataForSEO's, and the previous run's page (DataForSEO's) would look "different".
  return env.DATAFORSEO_POISON_CHECK !== "0" && env.RANK_PROVIDER?.trim().toLowerCase() !== "serper";
}

function siteOf(item: { url?: unknown; breadcrumb?: unknown }): string | null {
  const u = resultUrl(item);
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : null;
}

/** The organic results' sites, in rank order, each once (a Google redirect without a breadcrumb is skipped). */
export function organicSites(body: unknown): string[] {
  const items = (body as { tasks?: { result?: { items?: unknown[] }[] }[] })?.tasks?.[0]?.result?.[0]?.items;
  if (!Array.isArray(items)) return [];
  const organic = (items as { type?: string; rank_group?: number; url?: unknown; breadcrumb?: unknown }[])
    .filter((i) => i?.type === "organic")
    .sort((a, b) => (a.rank_group ?? 0) - (b.rank_group ?? 0));
  const out: string[] = [];
  for (const i of organic) {
    const s = siteOf(i);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Share of `usual` (a page's top sites) that appear anywhere in `page`. Null when either side is too thin to judge. */
export function sharedShare(usual: string[], page: string[]): number | null {
  if (usual.length < MIN_SITES || page.length < MIN_SITES) return null;
  const set = new Set(page);
  return Math.round((usual.filter((s) => set.has(s)).length / usual.length) * 100) / 100;
}

/** A successful answer with results (only those are checked; errors go through the normal retry path). */
export function hasResults(body: unknown): boolean {
  const task = (body as { tasks?: { status_code?: number; result?: { items?: unknown }[] }[] })?.tasks?.[0];
  return task?.status_code === 20000 && Array.isArray(task?.result?.[0]?.items);
}

/**
 * Decide which answer to use. `ask` makes the extra call (only used when the first page looks poisoned).
 * Pure apart from `ask`, so tests drive it directly.
 */
export async function checkSerp<T>(
  first: { body: unknown; result: T },
  previousTop: string[] | null,
  ask: () => Promise<{ body: unknown; result: T } | null>,
): Promise<{ use: { body: unknown; result: T }; check: SerpCheck }> {
  const firstSites = organicSites(first.body);
  const firstShare = previousTop ? sharedShare(previousTop, firstSites) : null;
  if (firstShare === null) return { use: first, check: { status: "no_previous", share: null, retried: false } };
  if (firstShare >= POISON_THRESHOLD) return { use: first, check: { status: "ok", share: firstShare, retried: false } };

  const second = await ask();
  if (!second || !hasResults(second.body)) {
    // The extra call failed: keep the first answer, flagged.
    return { use: first, check: { status: "suspect", share: firstShare, retried: true } };
  }
  const secondSites = organicSites(second.body);
  const secondShare = sharedShare(previousTop!, secondSites);
  const agree = sharedShare(firstSites.slice(0, PREVIOUS_TOP), secondSites);
  const base = { firstShare, firstVsRetry: agree, retried: true };
  if (secondShare !== null && secondShare >= POISON_THRESHOLD) return { use: second, check: { status: "ok_after_retry", share: secondShare, ...base } };
  if (agree !== null && agree >= POISON_THRESHOLD) return { use: second, check: { status: "changed", share: secondShare, ...base } };
  return { use: second, check: { status: "suspect", share: secondShare, ...base } };
}

/**
 * The same keyword's page in the client's previous run (same Google domain and location): its top-20 sites,
 * from the newest saved answer that has results. Null when there's none or it's too thin to judge.
 */
export async function previousTopSites(row: { runId: string; keyword: string; seDomain: string; locationName: string }): Promise<{ sites: string[]; runId: string } | null> {
  // First pick the one attempt (cheap), then read only its organic items -- raw answers can be large.
  const found = await prisma.$queryRaw<{ run_id: string; items: unknown[] | null }[]>`
    WITH pick AS (
      SELECT a.id, r.run_id
      FROM ranking_runs cur
      JOIN ranking_runs prev ON prev.client_id = cur.client_id AND prev.id <> cur.id AND prev.created_at < cur.created_at
      JOIN ranking_rows r ON r.run_id = prev.id
      JOIN ranking_row_attempts a ON a.ranking_row_id = r.id
      WHERE cur.id = ${row.runId}
        AND lower(trim(r.keyword)) = lower(trim(${row.keyword}))
        AND r.se_domain = ${row.seDomain}
        AND r.location_name = ${row.locationName}
        AND a.raw_response IS NOT NULL
        AND jsonb_typeof(a.raw_response->'tasks'->0->'result'->0->'items') = 'array'
      ORDER BY prev.created_at DESC, a.created_at DESC
      LIMIT 1
    )
    SELECT pick.run_id,
           (SELECT jsonb_agg(x.i ORDER BY (x.i->>'rank_group')::int)
              FROM (SELECT i FROM jsonb_array_elements(a.raw_response->'tasks'->0->'result'->0->'items') i
                     WHERE i->>'type' = 'organic'
                     ORDER BY (i->>'rank_group')::int
                     LIMIT 60) x) AS items
    FROM pick JOIN ranking_row_attempts a ON a.id = pick.id`;
  const hit = found[0];
  if (!hit?.items) return null;
  const sites = organicSites({ tasks: [{ result: [{ items: hit.items }] }] }).slice(0, PREVIOUS_TOP);
  return sites.length >= MIN_SITES ? { sites, runId: hit.run_id } : null;
}
