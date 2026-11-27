import { fetchGoogleAdsKeywordIdeas, type PlannerIdea } from "../reporting/keywordPlanner.js";
import { bareDomain } from "./fetchers/flikoverAhrefs.js";

/**
 * Google Keyword Planner as the Domain Keyword Report's 4th section (the team's ask, 2026-11-27): next to what
 * Semrush, Ubersuggest and Ahrefs say the site ranks for, the service keywords Google itself suggests for the
 * whole site ("Start with a website"), with Google's average monthly searches. Server-side through the Google
 * Ads API -- no office Chrome needed. null when the GOOGLE_ADS_* variables aren't set.
 */
export type PlannerIdeasFn = (input: { websiteUrl: string; location: string | null }) => Promise<PlannerIdea[]>;

/** Domain Intelligence's location (Semrush database codes: "au", "uk", ...) -> Google Ads country. */
export function plannerCountryOf(location: string | null): string {
  const code = (location ?? "au").trim().toLowerCase();
  return code === "uk" ? "GB" : code.toUpperCase();
}

/**
 * Google only knows a site under the host it's served on: pinakigroup.in gave 0 ideas, www.pinakigroup.in 128
 * (2026-11-27). So the site as typed first, then the www / non-www twin when Google has nothing.
 */
export function createGooglePlannerIdeas(deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): PlannerIdeasFn {
  return async ({ websiteUrl, location }) => {
    const host = bareDomain(websiteUrl).toLowerCase();
    const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
    for (const site of [host, twin]) {
      const ideas = await fetchGoogleAdsKeywordIdeas(site, plannerCountryOf(location), deps);
      if (ideas.length > 0) return ideas;
    }
    return [];
  };
}

/** How many of Google's ideas get an intent check, and how many service keywords the section shows at most. */
export const PLANNER_CANDIDATES = 300;
export const PLANNER_MAX_ROWS = 100;

/** "Service" keywords: someone looking to hire or buy (Commercial / Transactional), not just reading. */
export const SERVICE_INTENTS = ["Commercial", "Transactional"];
