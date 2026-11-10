import { normalizeKeyword } from "../baselines/normalizeKeyword.js";

/**
 * The Baseline Report's extra columns (2026-11-10), worked out the way the team's handover sheet
 * ("Baseline Report - Handover.pdf", Steps 1-5) tells Claude in Chrome to fill them by hand:
 *   Number of Result  -- Google's result count, Indian format + " results"
 *   SERP result       -- what kind of page each of the top 10 organic results is ("2 Home page, 8 Service page")
 *   Intent            -- one word
 *   Avg. Monthly Searches / Competition -- Keyword Planner, converted to the team's buckets
 * Here they come from the run's own DataForSEO answer (the full top 100 is saved per keyword) and the
 * Keyword Planner numbers (KeywordMetric). SERP result and Intent are rules on the URLs/keyword -- an
 * estimate the team checks, exactly as they checked Claude's.
 */

// ---------------------------------------------------------------- Number of Result

/** 61200000 -> "6,12,00,000 results" (Indian grouping: last 3 digits, then pairs). */
export function formatIndianResults(count: number | null | undefined): string | null {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 0) return null;
  const digits = String(Math.round(count));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${grouped} results`;
}

// ---------------------------------------------------------------- Search volume / competition

/** Keyword Planner's "Avg. monthly searches" (a range like "10 – 100" / "1K – 10K", or a number) -> the team's value. */
export function volumeBucket(raw: string | number | null | undefined): string | number {
  if (raw === null || raw === undefined) return "0 – 10";
  const text = String(raw).trim();
  if (!text || /^[-–—]+$/.test(text)) return "0 – 10";
  const toNumber = (s: string): number | null => {
    const m = s.trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([KkMm])?$/);
    if (!m) return null;
    return Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1_000 : 1_000_000) : 1);
  };
  const range = text.split(/\s*[-–—]\s*/);
  if (range.length === 2) {
    const low = toNumber(range[0]);
    if (low !== null && toNumber(range[1]) !== null) return bucketOf(low); // a range goes by its lower end: "10 – 100" -> 50
  }
  const n = toNumber(text);
  return n === null ? "0 – 10" : bucketOf(n);
}

// Handover Step 5: 0-10 -> "0 – 10", 10-100 -> 50, 100-1K -> 500, 1K-10K -> 5000 (and on the same way upwards).
function bucketOf(value: number): string | number {
  if (value < 10) return "0 – 10";
  if (value < 100) return 50;
  if (value < 1_000) return 500;
  if (value < 10_000) return 5000;
  if (value < 100_000) return 50000;
  if (value < 1_000_000) return 500000;
  return 5000000;
}

/** "Low"/"LOW"/"Medium"/"High" stay; "—", blank, "UNSPECIFIED"... -> "Unknown". */
export function competitionLabel(raw: string | null | undefined): string {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "low") return "Low";
  if (t === "medium") return "Medium";
  if (t === "high") return "High";
  return "Unknown";
}

/** Keyword Planner merges keywords with the same words in a different order -- matched by their sorted words. */
export function wordSetKey(keyword: string): string {
  return normalizeKeyword(keyword).split(" ").sort().join(" ");
}

// ---------------------------------------------------------------- SERP result

export const SERP_CATEGORIES = [
  "Home page",
  "Service page",
  "Product page",
  "Blog page",
  "Contact page",
  "Directory/Listing",
  "Forum page",
  "Social media",
  "PDF",
  "Other",
] as const;
export type SerpCategory = (typeof SERP_CATEGORIES)[number];

const SOCIAL = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.com|linkedin\.com|reddit\.com|tiktok\.com|twitter\.com|x\.com|pinterest\.[a-z.]+|threads\.net)$/;
const FORUM_HOSTS = /(^|\.)(quora\.com|stackexchange\.com|stackoverflow\.com|whirlpool\.net\.au|boards\.ie|mumsnet\.com|teambhp\.com)$/;
const DIRECTORY_HOSTS =
  /(^|\.)(yelp\.[a-z.]+|mapquest\.com|yellowpages\.[a-z.]+|yellow\.com\.au|truelocal\.com\.au|hotfrog\.[a-z.]+|justdial\.com|sulekha\.com|indiamart\.com|startlocal\.com\.au|localsearch\.com\.au|oneflare\.com\.au|hipages\.com\.au|airtasker\.com|serviceseeking\.com\.au|productreview\.com\.au|womo\.com\.au|wordofmouth\.com\.au|zomato\.com|swiggy\.com|magicpin\.in|cylex[a-z.-]*|brownbook\.net|foursquare\.com|trustpilot\.com|clutch\.co|goodfirms\.co|bark\.com|houzz\.[a-z.]+|weddingwire\.[a-z.]+|easyweddings\.com\.au|weddingz\.in|wedmegood\.com|bayut\.com|dubizzle\.com|propertyfinder\.ae|99acres\.com|magicbricks\.com|nobroker\.in|realestate\.com\.au|domain\.com\.au|tradiehub\.net|finda\.co\.nz|yably\.[a-z.]+|n49\.com|threebestrated\.[a-z.]+|expertise\.com|nearestdirectory\.com|connect2local\.[a-z.]+|maps\.apple\.com|themanifest\.com|revenuebase\.ai|sortlist\.[a-z.]+|designrush\.com|tourradar\.com|expedia\.[a-z.]+|booking\.com|agoda\.com|makemytrip\.com|viator\.com|getyourguide\.[a-z.]+|klook\.com|shiksha\.com|collegedunia\.com|urbanpro\.com)$/;
const SHOPPING_CENTRE_HOST = /(westfield|centre|center|shopping|mall|plaza|square|stockland|vicinity|scentre)/;
const MARKETPLACE_HOSTS = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|flipkart\.com|etsy\.com|noon\.com|myntra\.com|ajio\.com|meesho\.com|catch\.com\.au|kogan\.com|bunnings\.com\.au|ikea\.com|temu\.com|alibaba\.com|aliexpress\.com)$/;
const BLOG_HOSTS = /(^|\.)(medium\.com|wordpress\.com|blogspot\.com|weebly\.com|wixsite\.com|substack\.com|tripoto\.com|lonelyplanet\.com|roughguides\.com|wikihow\.com|wikipedia\.org|britannica\.com|investopedia\.com)$/;

/** The page a search result points to: the real URL, or (for a Google redirect the converter couldn't resolve) its breadcrumb. */
export function resultUrl(item: { url?: unknown; breadcrumb?: unknown; domain?: unknown }): URL | null {
  const raw = String(item.url ?? "");
  const isRedirect = /^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)\?/i.test(raw);
  if (raw && !isRedirect) {
    try {
      return new URL(raw);
    } catch {
      /* fall through */
    }
  }
  // Breadcrumb "https://www.site.com.au › services › car-wash" -> https://www.site.com.au/services/car-wash
  const crumb = String(item.breadcrumb ?? "").trim();
  const m = crumb.match(/^(https?:\/\/[^\s›>]+)((?:\s*[›>]\s*[^›>]+)*)$/);
  if (m) {
    const parts = m[2].split(/[›>]/).map((p) => p.trim()).filter((p) => p && p !== "...");
    try {
      return new URL(`${m[1].replace(/\/$/, "")}/${parts.join("/")}`);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Handover Step 1: which kind of page one organic result is. */
export function classifySerpUrl(url: URL | null): SerpCategory {
  if (!url) return "Other";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponent(url.pathname).toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const pathAndQuery = `${path}${url.search.toLowerCase()}`;

  if (/\.pdf$/.test(path)) return "PDF";
  if (SOCIAL.test(host)) return "Social media";
  if (FORUM_HOSTS.test(host)) return "Forum page";
  if (/tripadvisor/.test(host)) return /showtopic|forum/.test(pathAndQuery) ? "Forum page" : "Directory/Listing";
  if (/(^|\.)(forum|forums|community|discuss)\./.test(host) || /\/(forum|forums|threads?|community|discussions?|showthread)(\/|\.|$)/.test(path)) return "Forum page";
  if (DIRECTORY_HOSTS.test(host)) return "Directory/Listing";
  if (SHOPPING_CENTRE_HOST.test(host) && /\/(stores?|shops?|retailers?|directory)(\/|$)/.test(path)) return "Directory/Listing";
  if (/\/(directory|listings?|business-directory)(\/|$)/.test(path)) return "Directory/Listing";
  if (BLOG_HOSTS.test(host)) return "Blog page";
  if (MARKETPLACE_HOSTS.test(host)) return "Product page";

  const home = segments.length === 0 || (segments.length === 1 && /^(index\.(html?|php|aspx?)|home|en|en-[a-z]{2}|[a-z]{2}-[a-z]{2})$/.test(segments[0]));
  if (home) return "Home page";
  // "Directions, getting here or showroom pages count as Contact page."
  if (/(^|[\/-])(contact|contact-us|contactus|directions|getting-here|get-here|find-us|how-to-find-us|showrooms?|visit-us|our-location)([\/-]|\.|$)/.test(path)) return "Contact page";
  if (segments.some((seg) => /^(blogs?|news|articles?|insights?|guides?|resources|posts?|stories|magazine|journal|learn|knowledge|tips|advice|faqs?|how-to|travel-tips|travel-guides?|trip-reports?)$|(^|-)blogs?(-|$)/.test(seg))) return "Blog page";
  const slug = (segments[segments.length - 1] ?? "").replace(/\.(html?|php|aspx?)$/, "");
  const slugWords = slug.split("-").filter(Boolean);
  // An article title as the address: "how-to-...", "best-msp-in-sydney", "ultimate-madagascar-travel-guide-and-tips".
  if (slugWords.length >= 5 && /^(how|what|why|when|where|which|who|is|are|can|does|do|should|top|\d+)$/.test(slugWords[0])) return "Blog page";
  if (slugWords.length >= 4 && /^(best|top|ultimate|complete)$/.test(slugWords[0])) return "Blog page";
  if (slugWords.length >= 4 && slugWords.some((w) => /^(guide|tips|itinerary|itineraries|trip-report|things|vs|review|reviews|cost|costs|explained)$/.test(w))) return "Blog page";
  if (/\/(products?|shop|store|collections?|catalog(ue)?|item|p|buy)(\/|$)/.test(path) || (/\.html?$/.test(path) && /product/.test(path))) return "Product page";
  // Suburb, branch and location pages count as Service page (never "Location page").
  return "Service page";
}

export interface OrganicItem {
  url?: unknown;
  breadcrumb?: unknown;
  domain?: unknown;
  rank_group?: unknown;
  type?: unknown;
}

/** The top 10 organic results -> "2 Home page, 6 Service page, 2 Directory/Listing" (adds up to the results counted). */
export function serpSummary(top10: OrganicItem[]): { text: string; categories: SerpCategory[] } | null {
  if (top10.length === 0) return null;
  const categories = top10.slice(0, 10).map((item) => classifySerpUrl(resultUrl(item)));
  const counts = new Map<SerpCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const text = SERP_CATEGORIES.filter((c) => counts.has(c))
    .map((c) => `${counts.get(c)} ${c}`)
    .join(", ");
  return { text, categories };
}

// ---------------------------------------------------------------- Intent

const INFORMATIONAL = /^(how|what|why|when|who|which|is|are|can|does|do|should|will)\b|\b(how to|what is|meaning|definition|guide|tutorial|tips|ideas|examples?|steps|benefits|difference between|vs\.? difference|types of|history of|diy)\b/;
const COMMERCIAL = /\b(best|top|top \d+|vs|versus|compare|comparison|reviews?|rated|alternatives?|cheapest|cheap|affordable|budget)\b/;

/**
 * Handover Step 2, one word:
 *   Commercial -- "best ..." or comparing options;  Informational -- how-to / what-is, or a top 10 mostly guides;
 *   Navigational -- one specific place or brand;    Transactional -- service + area (the usual case).
 */
export function guessIntent(keyword: string, categories: SerpCategory[] | null, brandWords: string[] = []): string {
  const k = normalizeKeyword(keyword);
  if (INFORMATIONAL.test(k)) return "Informational";
  if (COMMERCIAL.test(k)) return "Commercial";
  const words = new Set(k.split(" "));
  if (brandWords.some((b) => b.length >= 4 && (words.has(b) || k.replace(/\s+/g, "").includes(b)))) return "Navigational";
  if (/\b(town centre|town center|shopping centre|shopping center|mall|plaza|westfield)\b/.test(k)) return "Navigational";
  if (categories && categories.length >= 5 && categories.filter((c) => c === "Blog page").length / categories.length > 0.5) return "Informational";
  return "Transactional";
}

/** "thewashouse.com.au" -> ["thewashouse", "washouse"]: words that make a search about the client's own brand. */
export function brandWordsOf(domain: string | null | undefined): string[] {
  if (!domain) return [];
  const label = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/)[0] ?? "";
  if (!label) return [];
  const out = new Set([label.replace(/-/g, "")]);
  if (label.startsWith("the") && label.length > 6) out.add(label.slice(3));
  return [...out];
}
