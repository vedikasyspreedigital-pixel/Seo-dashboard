// The one and only join key for matching an imported baseline against a
// later real run's rows: normalized keyword text, per the explicit
// requirement (a baseline has no targetUrl/locationName/seDomain/
// languageName to match on, unlike RankingRow's rowUid-based cross-run
// matching -- see prisma/schema.prisma's RankingBaselineRow comment).
// Must be used identically at both write time (persisting a
// RankingBaselineRow.normalizedKeyword) and read time (matching a current
// run's row.keyword against it) or the join silently never matches.
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

// Real-world scanned/exported reports are inconsistent about this exact
// string -- the sample PDF this feature was built against has BOTH
// "Not in 100" and "Not in100" in the same file. Treated as a rank of null
// (not a parse error) regardless of internal spacing/case.
const NOT_IN_100_PATTERN = /^not\s*in\s*100$/i;

// A Google domain sitting where a rank should be ("google.com.sa",
// "Google.ae", "www.google.co.in") marks a report's LOCATION SECTION row,
// not a keyword: multi-location agency reports (e.g. Twin Crown, 2026-09)
// group keywords under rows like "Saudi Arabia | google.com.sa |
// google.com.sa", and the top "Current Ranking Status: | Google.ae |
// Google.ae" row has the same shape. A real keyword's rank cell is a number,
// "Not in 100" or blank -- never a search-engine domain.
const SEARCH_ENGINE_CELL = /^(?:https?:\/\/)?(?:www\.)?google(?:\.[a-z]{2,3}){1,2}\/?$/i;

export function isSearchEngineDomainCell(raw: string | null | undefined): boolean {
  return SEARCH_ENGINE_CELL.test((raw ?? "").toString().trim());
}

/**
 * "8" -> 8, "Not in100" / "not in 100" -> null (explicitly "not ranked",
 * not a missing value), "" or unparseable -> null (same bucket -- a
 * baseline row with a blank/garbled rank cell is safest treated as
 * "unranked" rather than thrown away, since it's still a real keyword the
 * client was tracking).
 */
export function parseBaselineRank(raw: string | null | undefined): { rankValue: number | null; rankDisplay: string | null } {
  const trimmed = (raw ?? "").toString().trim();
  if (trimmed === "") return { rankValue: null, rankDisplay: null };
  if (NOT_IN_100_PATTERN.test(trimmed)) return { rankValue: null, rankDisplay: "Not in 100" };
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber > 0) return { rankValue: asNumber, rankDisplay: String(asNumber) };
  return { rankValue: null, rankDisplay: null };
}
