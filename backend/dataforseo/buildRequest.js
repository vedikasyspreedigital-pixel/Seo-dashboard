// Locked request mapping (see architecture discussion): the wildcard
// target is sent verbatim (only surrounding whitespace is trimmed), never
// otherwise normalized. device/os/depth are fixed constants matching the
// original Make.com scenario.

const DEVICE = 'desktop';
const OS = 'windows';
const DEPTH = 100;

// Hand-typed Excel values that DataForSEO rejects outright with 40501
// ("Invalid Field"), failing EVERY row of a run on its first attempt --
// confirmed in production (AKT, Advanced SEO, 2026-10-01): a Domain cell of
// "Google.co.in" (-> Invalid Field: 'se_domain') and a Full URL cell of
// "advkanchantalreja.com/" (-> Invalid Field: 'stop_crawl_on_match' -
// invalid 'match_value'). Both are cleaned here, at request-build time only:
// the stored RankingRow values (and so each row's rowUid identity, which
// verified-Excel matching depends on) are untouched.

/**
 * Google domain as DataForSEO's `se_domain` expects it: lowercase bare host.
 * "Google.co.in" / " GOOGLE.CO.IN " / "https://www.google.co.in/" -> "google.co.in".
 */
export function normalizeSeDomain(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // protocol
    .split(/[/?#]/)[0] // any path/query
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

// A plain hostname: dot-separated labels of letters/digits/hyphens (no label
// starting or ending with a hyphen), ending in an alphabetic TLD. Punycode
// ("xn--...") labels pass too.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * The client's site as stop_crawl_on_match's `match_value` expects it: a bare
 * domain (match_type "with_subdomains" already covers www. and every other
 * subdomain). "advkanchantalreja.com/" / "https://www.Example.com/page?x=1"
 * -> "advkanchantalreja.com" / "example.com". Returns null when what's left
 * still isn't a hostname (e.g. "*pangalark.*", "n/a") -- the caller then omits
 * stop_crawl_on_match, exactly like an empty Full URL cell.
 */
export function normalizeMatchDomain(raw) {
  const host = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // protocol
    .split(/[/?#]/)[0] // path, query, fragment
    .replace(/^[^@]*@/, '') // user:pass@
    .replace(/:\d+$/, '') // port
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return HOSTNAME.test(host) ? host : null;
}

/**
 * @param {{ keyword: string, targetUrl: string, fullUrl?: string | null, locationName: string, seDomain: string, languageName: string }} row
 */
// stop_crawl_on_match: crawls the SAME full depth=100 as before when nothing
// matches (verified live: a genuine non-match still returns pages_count=10,
// full cost) -- only stops the crawl early once the target is actually
// found (verified live: a genuine match returns on page 1 at ~1/8th the
// cost), so this changes cost, never accuracy or coverage.
//
// `target`/`targetUrl` (e.g. "*pangalark.*") is a bare business-name
// fragment with no TLD -- fine for the `target` filter itself, but
// DataForSEO's stop_crawl_on_match rejects it as `match_value` ("Invalid
// Field: 'stop_crawl_on_match' - invalid 'match_value'", confirmed live).
// `fullUrl` (the Excel's "Full URL" column, e.g. "pangalark.com.au") is the
// real domain, and match_type "with_subdomains" (root domain + all
// subdomains, e.g. matches "www.pangalark.com.au" too -- confirmed live)
// accepts it correctly. find_targets_in restricts the early-stop match to
// organic results only, so a paid ad on the same domain can never cut the
// crawl short before a real organic ranking (or the lack of one) is found.
//
// fullUrl is optional in the schema (unlike targetUrl) -- omit
// stop_crawl_on_match entirely rather than send a request DataForSEO would
// reject when it's missing (or not a usable domain even after cleaning);
// falls back to the exact same always-depth-100 behavior as before for that
// row. Omitting it only ever costs more, never changes a result.
export function buildDataForSeoRequest(row) {
  const payload = {
    keyword: row.keyword,
    target: String(row.targetUrl ?? '').trim(),
    location_name: row.locationName,
    se_domain: normalizeSeDomain(row.seDomain),
    language_name: row.languageName,
    device: DEVICE,
    os: OS,
    depth: DEPTH,
  };
  const matchDomain = normalizeMatchDomain(row.fullUrl);
  if (matchDomain) {
    payload.stop_crawl_on_match = [{ match_type: 'with_subdomains', match_value: matchDomain }];
    payload.find_targets_in = ['organic'];
  }
  return payload;
}
