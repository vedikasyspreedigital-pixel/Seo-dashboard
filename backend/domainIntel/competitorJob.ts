import { randomUUID } from "node:crypto";
import { FetchError, bareDomain, runExclusive, type FetchExportFn } from "./fetchers/flikoverAhrefs.js";

// "Find competitors" for the Keyword Analysis report (team's decision,
// 2026-10-23: the client's keywords + 3 competitors' side by side). The office
// Chrome agent reads Semrush Domain Overview's "Main Organic Competitors"
// (in Semrush's own order, by competition level) and sends it back as a small
// CSV; the page then offers the top 3, which the team can change. Jobs live in
// memory -- the list is only needed until the competitors are fetched.

export interface Competitor {
  domain: string;
  /** Keywords the competitor shares with the client ("Com. Keywords"). */
  commonKeywords: number | null;
  /** All the competitor's keywords in this database ("SE Keywords"). */
  totalKeywords: number | null;
}

export interface CompetitorJob {
  id: string;
  clientId: string;
  workspaceId: string | null;
  websiteUrl: string;
  location: string | null;
  state: "queued" | "running" | "done" | "failed";
  step?: string;
  competitors?: Competitor[];
  error?: string;
  code?: string;
  createdAt: string;
  updatedAt: string;
}

/** How many competitors the report uses (team's decision). */
export const COMPETITOR_COUNT = 3;
const KEEP_MS = 24 * 60 * 60 * 1000;
const jobs = new Map<string, CompetitorJob>();

function update(job: CompetitorJob, patch: Partial<CompetitorJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

export class CompetitorJobError extends Error {}

const toCount = (s: string | undefined) => {
  const m = (s ?? "").trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K"] ?? 1));
};

/** The agent's CSV ("Domain,Com. Level rank,Com. Keywords,SE Keywords") -> competitors, minus the client itself. */
export function parseCompetitorsCsv(text: string, clientDomain: string): Competitor[] {
  const own = bareDomain(clientDomain);
  const seen = new Set<string>();
  const out: Competitor[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [domain, , common, total] = line.split(",");
    const d = bareDomain(domain ?? "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d === own || seen.has(d)) continue;
    seen.add(d);
    out.push({ domain: d, commonKeywords: toCount(common), totalKeywords: toCount(total) });
  }
  return out;
}

export function startCompetitorSearch(
  input: { client: { id: string; workspaceId: string | null }; websiteUrl: string; location: string | null },
  fetcher: FetchExportFn | undefined,
): CompetitorJob {
  if (!fetcher) throw new CompetitorJobError("Finding competitors needs the office Chrome agent -- type the competitors' websites instead.");
  const running = [...jobs.values()].find((j) => j.clientId === input.client.id && (j.state === "queued" || j.state === "running"));
  if (running) return running;
  const cutoff = Date.now() - KEEP_MS;
  for (const j of jobs.values()) if (j.state !== "queued" && j.state !== "running" && Date.parse(j.updatedAt) < cutoff) jobs.delete(j.id);
  const now = new Date().toISOString();
  const job: CompetitorJob = {
    id: randomUUID(),
    clientId: input.client.id,
    workspaceId: input.client.workspaceId,
    websiteUrl: input.websiteUrl,
    location: input.location,
    state: "queued",
    step: "Waiting for the office Chrome agent",
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  void (async () => {
    try {
      const result = await runExclusive(() => {
        update(job, { state: "running" });
        return fetcher({ domain: bareDomain(job.websiteUrl), location: job.location, onStep: (step) => update(job, { step }) });
      });
      const competitors = parseCompetitorsCsv(result.buffer.toString("utf8"), job.websiteUrl);
      if (competitors.length === 0) throw new FetchError("FAILED", "Semrush listed no organic competitors for this site -- type them instead.");
      update(job, { state: "done", step: undefined, competitors });
    } catch (err) {
      const code = err instanceof FetchError ? err.code : "FAILED";
      if (!(err instanceof FetchError)) console.error(`[domainIntel] competitor search ${job.id} failed:`, err);
      update(job, { state: "failed", step: undefined, code, error: (err as Error).message.slice(0, 500) });
    }
  })();
  return job;
}

export function getCompetitorSearch(id: string): CompetitorJob | undefined {
  return jobs.get(id);
}

export function publicCompetitorSearch(job: CompetitorJob) {
  const { workspaceId: _ws, ...rest } = job;
  return rest;
}

/** Tests only. */
export function clearCompetitorSearches() {
  jobs.clear();
}
