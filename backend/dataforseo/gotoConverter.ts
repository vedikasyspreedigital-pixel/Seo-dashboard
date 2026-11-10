// DataForSEO's free GoTo URL Converter (Nick at DataForSEO support, 2026-11-06). Since ~30 Oct Google
// returns most organic results as https://google.<tld>/goto?url=... links that DataForSEO can't always
// resolve in time (Google throttles it -- Live and high priority resolve only some), so the client's
// own result carries no address and isn't recognised. The converter turns those links into the real
// URLs at no cost:
//   POST https://api.dataforseo.com/v3/appendix/goto_url_converter
//   body  [{ "goto_urls": ["https://google.com/goto?url=...", ...] }]
//   reply tasks[0].result[] = { goto, url }        cost 0
// Every search response passes through here BEFORE it is saved and matched: each converted item gets
// its real `url` (and `domain`), with the redirect kept in `google_url` and `url_source: "goto_converter"`.
// A link the converter can't resolve, or a converter failure, leaves the item as it was -- the
// breadcrumb fallback (targetMatch.js) still applies to it. Never makes a search fail.

import type { DataForSeoCallResult } from "./client.js";
import type { StandardClient } from "./standardClient.js";
import { isGoogleRedirect } from "./targetMatch.js";

export const GOTO_CONVERTER_URL = "https://api.dataforseo.com/v3/appendix/goto_url_converter";
/** Links per converter call (there's no documented limit; a depth-100 SERP has ~100 items). */
const BATCH = 100;
const TIMEOUT_MS = 30_000;

/** goto link -> real URL, for the links it could resolve. */
export type ConvertGotoFn = (gotoUrls: string[]) => Promise<Map<string, string>>;

export function createGotoConverter({ fetchImpl = fetch, url = GOTO_CONVERTER_URL }: { fetchImpl?: typeof fetch; url?: string } = {}): ConvertGotoFn {
  return async (gotoUrls) => {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    const out = new Map<string, string>();
    if (!login || !password || gotoUrls.length === 0) return out;
    for (let i = 0; i < gotoUrls.length; i += BATCH) {
      const batch = gotoUrls.slice(i, i + BATCH);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"), "Content-Type": "application/json" },
        body: JSON.stringify([{ goto_urls: batch }]),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json()) as { tasks?: { status_code?: number; result?: { goto?: string; url?: string }[] | null }[] };
      for (const r of body?.tasks?.[0]?.result ?? []) {
        if (typeof r?.goto === "string" && typeof r?.url === "string" && /^https?:\/\//i.test(r.url) && !isGoogleRedirect(r.url)) out.set(r.goto, r.url);
      }
    }
    return out;
  };
}

function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
}

type Item = { type?: string; url?: unknown; domain?: unknown; [k: string]: unknown };

/** The redirect links in a SERP response (all result entries). */
export function gotoLinksIn(body: unknown): string[] {
  const results = (body as { tasks?: { result?: { items?: Item[] }[] | null }[] })?.tasks?.[0]?.result ?? [];
  const links = new Set<string>();
  for (const result of results ?? []) for (const item of result?.items ?? []) if (typeof item?.url === "string" && isGoogleRedirect(item.url)) links.add(item.url);
  return [...links];
}

/** The same response with every convertible redirect replaced by its real URL. Never mutates the input. */
export function applyResolvedLinks(body: unknown, resolved: Map<string, string>): unknown {
  if (resolved.size === 0) return body;
  const b = body as { tasks: { result: { items?: Item[] }[] }[] };
  const task = b.tasks[0];
  const result = task.result.map((r) =>
    Array.isArray(r?.items)
      ? {
          ...r,
          items: r.items.map((item) => {
            const real = typeof item?.url === "string" ? resolved.get(item.url) : undefined;
            if (!real) return item;
            return { ...item, url: real, domain: hostOf(real) ?? item.domain, google_url: item.url, url_source: "goto_converter" };
          }),
        }
      : r,
  );
  return { ...b, tasks: [{ ...task, result }, ...b.tasks.slice(1)] };
}

/** Resolves a response's redirect links; on any converter problem, the response is returned unchanged. */
export async function resolveGotoLinks(body: unknown, convert: ConvertGotoFn): Promise<unknown> {
  const links = gotoLinksIn(body);
  if (links.length === 0) return body;
  try {
    return applyResolvedLinks(body, await convert(links));
  } catch (err) {
    console.warn(`[dataforseo] GoTo URL converter failed for ${links.length} link(s) -- using breadcrumbs instead:`, (err as Error).message);
    return body;
  }
}

async function resolveCall(result: DataForSeoCallResult, convert: ConvertGotoFn): Promise<DataForSeoCallResult> {
  if (!result.body || result.transportError) return result;
  return { ...result, body: await resolveGotoLinks(result.body, convert) };
}

/** Live: every search answer comes back with real URLs. */
export function withGotoResolution<P>(call: (payload: P) => Promise<DataForSeoCallResult>, convert: ConvertGotoFn): (payload: P) => Promise<DataForSeoCallResult> {
  const wrapped = async (payload: P) => resolveCall(await call(payload), convert);
  // So "is this the real Live call?" checks (runs.ts: refuse runs without DataForSEO's login) still see through it.
  return Object.assign(wrapped, { wrapped: call });
}

/** The function under any withGotoResolution wrapper. */
export function unwrapCall<T>(fn: T): unknown {
  return (fn as { wrapped?: unknown })?.wrapped ?? fn;
}

/** Standard queue: each collected result (task_get) comes back with real URLs. */
export function standardClientWithGotoResolution(client: StandardClient, convert: ConvertGotoFn): StandardClient {
  return { ...client, taskGet: async (id) => resolveCall(await client.taskGet(id), convert) };
}

/** On unless DATAFORSEO_GOTO_CONVERTER=0. */
export const gotoConverterEnabled = () => process.env.DATAFORSEO_GOTO_CONVERTER !== "0";
