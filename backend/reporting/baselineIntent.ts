import { INTENTS } from "../domainIntel/classifyIntent.js";
import { keywordKey } from "../domainIntel/readKeywordExport.js";

/**
 * Baseline Report Intent column (2026-11-16): Gemini gives ONE or TWO intents per keyword ("Commercial, Transactional")
 * when a keyword honestly has two -- the user's ask for the baseline. Domain Intelligence keeps its one-intent rule
 * (domainIntel/classifyIntent.ts); this is a separate call with its own prompt and answer shape.
 */

/** keywords + hints (keywordKey -> e.g. "Google's top 10 results: 7 Home page, 3 Service page") -> keywordKey -> "Commercial, Transactional". */
export type BaselineIntentFn = (
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  hints?: Map<string, string[]>,
) => Promise<Map<string, string>>;

const ORDER = ["Informational", "Navigational", "Commercial", "Transactional"];

/** Gemini when GEMINI_API_KEY is set; otherwise none (the rules write the column). */
export function defaultBaselineIntentFn(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): BaselineIntentFn | null {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";
  return async (keywords, context, hints = new Map()) => {
    const out = new Map<string, string>();
    for (let i = 0; i < keywords.length; i += BATCH) {
      try {
        for (const [k, v] of await geminiBatch(fetchImpl, apiKey, model, keywords.slice(i, i + BATCH), context, hints)) out.set(k, v);
      } catch (err) {
        console.error(`[baselineIntent] Gemini batch failed, the rules fill these in: ${(err as Error).message}`);
      }
    }
    return out;
  };
}

const BATCH = 100;

const PROMPT =
  "You label the search intent of SEO keywords for a client's Keyword Baseline Report. Intents: Informational (wants " +
  "information or an answer), Navigational (looking for a specific brand or website), Commercial (researching or " +
  "comparing options before deciding), Transactional (ready to book, buy, hire or act). Give the main intent first. " +
  "Add a SECOND intent only when a large share of searchers clearly mean it too (e.g. 'best kitchen renovation company " +
  "dubai' = Commercial, Transactional); otherwise give just one. Never more than two. Some keywords carry `hint` -- " +
  "what Google's top results are (home pages, service pages, blogs...) -- use it as evidence. Return every keyword exactly as given.";

/** "Transactional, Commercial" in the main-first order Gemini gave, at most two, no repeats. */
export function formatIntents(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const picked: string[] = [];
  for (const v of list) {
    const intent = ORDER.find((o) => o.toLowerCase() === String(v).trim().toLowerCase());
    if (intent && !picked.includes(intent)) picked.push(intent);
    if (picked.length === 2) break;
  }
  return picked.length ? picked.join(", ") : null;
}

async function geminiBatch(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  batch: string[],
  context: { clientName: string; websiteUrl: string },
  hints: Map<string, string[]>,
): Promise<Map<string, string>> {
  const items = batch.map((keyword) => {
    const h = hints.get(keywordKey(keyword));
    return h?.length ? { keyword, hint: h.join(" / ") } : { keyword };
  });
  let res: Response | null = null;
  // "High demand" (503) / rate limit (429) are usually brief.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 4000));
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Client: ${context.clientName} (${context.websiteUrl})\n\nKeywords (JSON):\n${JSON.stringify(items)}` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              results: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    keyword: { type: "STRING" },
                    intents: { type: "ARRAY", items: { type: "STRING", enum: [...INTENTS] }, minItems: 1, maxItems: 2 },
                  },
                  required: ["keyword", "intents"],
                },
              },
            },
            required: ["results"],
          },
        },
      }),
    });
    if (res.status !== 503 && res.status !== 429) break;
  }
  if (!res!.ok) throw new Error(`Gemini ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
  const body = (await res!.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const out = new Map<string, string>();
  let parsed: { results?: { keyword?: unknown; intents?: unknown }[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  for (const r of parsed.results ?? []) {
    const intents = formatIntents(r.intents);
    if (typeof r.keyword === "string" && intents) out.set(keywordKey(r.keyword), intents);
  }
  return out;
}
