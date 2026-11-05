// DataForSEO Standard (task_post) has no `target` parameter -- confirmed in
// the docs and in the sandbox on 2026-10-30, where a `target` sent to
// task_post was silently dropped from the task. Live's `target` filters the
// SERP server-side, so its response only holds the client's own items and
// mapResponse.js takes items[0] as the rank (recorded real Live response:
// target "*cash-for-cars-perth.*", 119 Google results, items_count 2).
//
// Standard returns every item, so this does that filtering here, following
// the target rules in DataForSEO's live/regular docs:
//   example.com                 the home page only (https://example.com)
//   example.com*                the domain, including all its pages
//   *example.com*               the domain, its pages and its subdomains
//   *example.com                the home page on any subdomain
//   example.com/example-page    that exact URL
// Both sides are compared without the protocol, a leading "www." or a
// trailing "/", case-insensitively; "*" matches anything.

function normalizeForTarget(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Builds a matcher for one target pattern (a row's targetUrl). Returns null
 * for an empty pattern -- nothing can match it.
 *
 * @param {string} target
 * @returns {((url: string) => boolean) | null}
 */
export function createTargetMatcher(target) {
  const pattern = normalizeForTarget(target);
  if (!pattern || /^\*+$/.test(pattern)) return null;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${source}$`);
  return (url) => regex.test(normalizeForTarget(url));
}

// Google redirect links (since about 30 Oct 2026): DataForSEO returns most results as
// https://google.<tld>/goto?url=... (or /url?...), with domain = google.<tld>, so the client's own result
// no longer carries its address. The real site is still in `breadcrumb` ("https://www.site.com › page ›
// …"). The "Unified Rank Matcher": a redirect item is matched by the address rebuilt from its breadcrumb.
const GOOGLE_REDIRECT = /^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)\?/i;

/** Is this a Google redirect link instead of the site's own address? */
export function isGoogleRedirect(url) {
  return GOOGLE_REDIRECT.test(String(url ?? ''));
}

/**
 * "https://www.site.com › services › …" -> "https://www.site.com/services". Truncated ("…"/"...")
 * segments are dropped. null when the breadcrumb doesn't start with a web address.
 */
export function urlFromBreadcrumb(breadcrumb) {
  const parts = String(breadcrumb ?? '')
    .split(/\s*[›»>]\s*/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(…|\.\.\.)$/.test(p));
  const host = parts[0];
  if (!host || !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/?$/i.test(host)) return null;
  const base = /^https?:\/\//i.test(host) ? host.replace(/\/$/, '') : `https://${host.replace(/\/$/, '')}`;
  const path = parts.slice(1).map((p) => p.replace(/[…]+$|\.\.\.$/, '').trim()).filter(Boolean);
  return path.length ? `${base}/${path.join('/')}` : base;
}

/** The address to match an item on: its url, or -- for a Google redirect -- the one rebuilt from its breadcrumb. */
export function itemAddress(item) {
  if (typeof item?.url !== 'string') return null;
  if (!isGoogleRedirect(item.url)) return item.url;
  return urlFromBreadcrumb(item.breadcrumb);
}

/**
 * Turns a Standard task_get response into the shape a Live response with
 * `target` would have had: the same body, with result[0].items narrowed to
 * the items whose address matches the target. Everything else -- status codes,
 * pages_count, se_results_count -- is kept, so mapResponse.js's rank,
 * "Not in 100" and shallow-coverage rules apply unchanged. Never mutates
 * the input (the full response is still saved as the attempt's raw_response).
 * A Google redirect item that matches by its breadcrumb is kept with the
 * rebuilt address as its url (that's the ranking URL recorded), and the
 * redirect link in `google_url`.
 *
 * @param {any} body  task_get/regular response body
 * @param {string} target  the row's targetUrl
 */
export function applyTargetFilter(body, target) {
  const result = body?.tasks?.[0]?.result?.[0];
  if (!result || !Array.isArray(result.items)) return body;
  const matches = createTargetMatcher(target);
  const items = [];
  if (matches) {
    for (const item of result.items) {
      const address = itemAddress(item);
      if (!address || !matches(address)) continue;
      items.push(address === item.url ? item : { ...item, url: address, google_url: item.url, url_source: 'breadcrumb' });
    }
  }
  const task = body.tasks[0];
  return {
    ...body,
    tasks: [{ ...task, result: [{ ...result, items, items_count: items.length }, ...task.result.slice(1)] }, ...body.tasks.slice(1)],
  };
}
