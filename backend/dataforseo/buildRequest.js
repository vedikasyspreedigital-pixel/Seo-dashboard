// Locked request mapping (see architecture discussion): the wildcard
// target is sent verbatim, never normalized. device/os/depth are fixed
// constants matching the original Make.com scenario.

const DEVICE = 'desktop';
const OS = 'windows';
const DEPTH = 100;

/**
 * @param {{ keyword: string, targetUrl: string, locationName: string, seDomain: string, languageName: string }} row
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
// reject when it's missing; falls back to the exact same always-depth-100
// behavior as before for that row.
export function buildDataForSeoRequest(row) {
  const payload = {
    keyword: row.keyword,
    target: row.targetUrl,
    location_name: row.locationName,
    se_domain: row.seDomain,
    language_name: row.languageName,
    device: DEVICE,
    os: OS,
    depth: DEPTH,
  };
  if (row.fullUrl) {
    payload.stop_crawl_on_match = [{ match_type: 'with_subdomains', match_value: row.fullUrl }];
    payload.find_targets_in = ['organic'];
  }
  return payload;
}
