import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { keywordKey } from "./readKeywordExport.js";

// Domain Intelligence: ONE search intent per keyword (the user's rule, 2026-10-19:
// "one reliable intent per keyword"), the same in every tool's block. Word
// patterns decide most keywords instantly and for free; the rest go to an AI
// (Gemini, or Claude -- see defaultAiClassifier) in one batched call per
// report, with the tools' own labels (Semrush's "Keyword Intents", Ahrefs'
// intent columns -- often several per keyword) as hints. Without AI (no key,
// or the call fails) a keyword with
// tool labels takes the most specific one (Transactional > Commercial >
// Navigational > Informational); anything else falls back to "Informational"
// and is counted as unresolved -- a missing key never blocks a report.

export const INTENTS = ["Informational", "Navigational", "Commercial", "Transactional"] as const;
export type Intent = (typeof INTENTS)[number];

export interface IntentResult {
  /** keywordKey(keyword) -> intent */
  intents: Map<string, Intent>;
  byPattern: number;
  byAi: number;
  /** Labelled from the tools' own labels (no AI available). */
  byToolLabels: number;
  /** Keywords neither patterns, AI nor tool labels could label -- given the fallback. */
  unresolved: number;
}

const FALLBACK: Intent = "Informational";
/** Most specific first: Ahrefs marks nearly everything Informational, so that one loses ties. */
const SPECIFICITY: Intent[] = ["Transactional", "Commercial", "Navigational", "Informational"];

/** The tools' labels for one keyword ("Informational, Commercial") -> the single most specific one. */
export function pickFromToolLabels(labels: Iterable<string>): Intent | null {
  const set = new Set([...labels].flatMap((l) => l.split(",").map((p) => p.trim())));
  return SPECIFICITY.find((i) => set.has(i)) ?? null;
}

const TRANSACTIONAL = /\b(buy|buying|order|orders|ordering|book|booking|bookings|hire|hiring|rent|rental|rentals|price|prices|pricing|cost|costs|quote|quotes|cheap|cheapest|discount|deal|deals|coupon|sale|shop|purchase|subscribe|download|delivery|near me|for hire|appointment)\b/;
const COMMERCIAL = /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|affordable|recommended|rated|rating|ratings|service|services|company|companies|agency|agencies|provider|providers|specialist|specialists|expert|experts|professional|professionals|luxury|premium)\b/;
// A question ("how to choose a chauffeur service") is research even when it names a service.
const QUESTION = /^(how|what|why|when|where|who|which|can|does|do|is|are|should)\b/;
const INFORMATIONAL = /\b(guide|tips|ideas|meaning|definition|tutorial|examples|example|history|benefits|learn|checklist|faq)\b/;
const NAVIGATIONAL = /\b(login|log in|sign in|official|website|contact|address|phone number|careers)\b/;

/** Brand words from the client name and website ("Melbourne Chauffeur", "https://www.melbournechauffeur.com.au") -- matched as whole phrases. */
export function brandTerms(clientName: string, websiteUrl: string): string[] {
  const terms = new Set<string>();
  const name = keywordKey(clientName.replace(/[^\p{L}\p{N}\s]/gu, " "));
  if (name.length >= 3) terms.add(name);
  const host = websiteUrl
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0];
  const label = host.split(".")[0];
  if (label && label.length >= 3) terms.add(label);
  return [...terms];
}

/** Is this a search for the brand itself ("yoga peace", "unplugged yoga")? */
export function matchesBrand(keyword: string, brands: string[]): boolean {
  const k = keywordKey(keyword);
  const squashed = k.replace(/\s+/g, "");
  if (brands.some((b) => k.includes(b) || squashed.includes(b.replace(/\s+/g, "")))) return true;
  // Its words in another order: "bayside yoga" for yogabayside.com.au (2-3 word keywords).
  const words = k.split(" ");
  if (words.length >= 2 && words.length <= 3 && squashed.length >= 6) {
    const orders = words.length === 2 ? [[1, 0]] : [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    if (orders.some((o) => brands.some((b) => b.replace(/\s+/g, "") === o.map((i) => words[i]).join("")))) return true;
  }
  // The brand name without the domain's extra words: "yoga peace" for yogapeaceaustralia.com.
  // Two+ words and 6+ letters, so a generic single word ("yoga") never counts as the brand.
  return k.includes(" ") && squashed.length >= 6 && brands.some((b) => b.replace(/\s+/g, "").startsWith(squashed));
}

export function classifyByPattern(keyword: string, brands: string[]): Intent | null {
  const k = keywordKey(keyword);
  if (matchesBrand(k, brands)) return "Navigational";
  if (NAVIGATIONAL.test(k)) return "Navigational";
  if (QUESTION.test(k)) return "Informational";
  if (TRANSACTIONAL.test(k)) return "Transactional";
  if (COMMERCIAL.test(k)) return "Commercial";
  if (INFORMATIONAL.test(k)) return "Informational";
  return null;
}

/** toolLabels: keywordKey -> the tools' own labels for it (hints only). */
export type ClassifyWithAiFn = (
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  toolLabels?: Map<string, string[]>,
) => Promise<Map<string, Intent>>;

export async function classifyIntents(
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  classifyWithAi: ClassifyWithAiFn | null = defaultAiClassifier(),
  toolLabels: Map<string, string[]> = new Map(),
): Promise<IntentResult> {
  const brands = brandTerms(context.clientName, context.websiteUrl);
  const intents = new Map<string, Intent>();
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const key = keywordKey(keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    const intent = classifyByPattern(keyword, brands);
    if (intent) intents.set(key, intent);
    else ambiguous.push(keyword);
  }
  const byPattern = intents.size;

  let byAi = 0;
  if (ambiguous.length > 0 && classifyWithAi) {
    try {
      const fromAi = await classifyWithAi(ambiguous, context, toolLabels);
      for (const keyword of ambiguous) {
        const intent = fromAi.get(keywordKey(keyword));
        if (intent) {
          intents.set(keywordKey(keyword), intent);
          byAi++;
        }
      }
    } catch (err) {
      console.error(`[domainIntel] AI intent classification failed, using "${FALLBACK}" for ${ambiguous.length} keyword(s): ${(err as Error).message}`);
    }
  }

  let byToolLabels = 0;
  let unresolved = 0;
  for (const keyword of ambiguous) {
    const key = keywordKey(keyword);
    if (intents.has(key)) continue;
    const fromTools = pickFromToolLabels(toolLabels.get(key) ?? []);
    if (fromTools) {
      intents.set(key, fromTools);
      byToolLabels++;
    } else {
      intents.set(key, FALLBACK);
      unresolved++;
    }
  }
  return { intents, byPattern, byAi, byToolLabels, unresolved };
}

/**
 * The AI step: Google Gemini when GEMINI_API_KEY is set (user's choice,
 * 2026-10-19 -- free tier), else Claude when ANTHROPIC_API_KEY is set, else
 * none (patterns + tool labels only).
 */
export function defaultAiClassifier(): ClassifyWithAiFn | null {
  if (process.env.GEMINI_API_KEY) {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
    return (keywords, context, toolLabels) => classifyWithGemini(apiKey, model, keywords, context, toolLabels ?? new Map());
  }
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return (keywords, context, toolLabels) => classifyWithClaude(client, keywords, context, toolLabels ?? new Map());
}

/** Which AI the intent step will use -- for the startup log. */
export function aiProviderName(): string | null {
  if (process.env.GEMINI_API_KEY) return `Gemini (${process.env.GEMINI_MODEL || "gemini-flash-lite-latest"})`;
  if (process.env.ANTHROPIC_API_KEY) return "Claude";
  return null;
}

const SYSTEM_PROMPT =
  "You label the search intent of SEO keywords. Use exactly one of: Informational (wants information or an answer), " +
  "Navigational (looking for a specific brand or website), Commercial (researching or comparing options before deciding), " +
  "Transactional (ready to book, buy, hire or act). Pick the ONE intent that best describes what most people " +
  "searching this mean. Some keywords carry `toolLabels` from SEO tools -- these often list several intents; treat " +
  "them as hints, not answers. Return every keyword exactly as given.";

function batchItems(batch: string[], toolLabels: Map<string, string[]>) {
  return batch.map((keyword) => {
    const hints = toolLabels.get(keywordKey(keyword));
    return hints?.length ? { keyword, toolLabels: [...new Set(hints)].join(" / ") } : { keyword };
  });
}

/** Gemini's REST API with a JSON response schema -- no SDK needed. */
async function classifyWithGemini(
  apiKey: string,
  model: string,
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  toolLabels: Map<string, string[]>,
): Promise<Map<string, Intent>> {
  const out = new Map<string, Intent>();
  // Small batches, a few at a time, each with a time limit: one 450-keyword call took over 2 minutes
  // (2026-10-21). A slow or failed batch only falls back for ITS keywords.
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += GEMINI_BATCH_SIZE) batches.push(keywords.slice(i, i + GEMINI_BATCH_SIZE));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        for (const [k, v] of await geminiBatch(apiKey, model, batch, context, toolLabels)) out.set(k, v);
      } catch (err) {
        console.error(`[domainIntel] Gemini batch of ${batch.length} keyword(s) failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GEMINI_PARALLEL, batches.length) }, worker));
  return out;
}

const GEMINI_BATCH_SIZE = 100;
const GEMINI_PARALLEL = 4;
const GEMINI_TIMEOUT_MS = 60_000;

async function geminiBatch(
  apiKey: string,
  model: string,
  batch: string[],
  context: { clientName: string; websiteUrl: string },
  toolLabels: Map<string, string[]>,
): Promise<Map<string, Intent>> {
  const out = new Map<string, Intent>();
  const items = batchItems(batch, toolLabels);
  // "High demand" (503) / rate limit (429) are usually brief: retry twice before the batch falls back.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 4000));
    res = await geminiRequest(apiKey, model, context, items);
    if (res.status !== 503 && res.status !== 429) break;
  }
  if (!res!.ok) throw new Error(`Gemini ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
  const body = (await res!.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out; // unparseable batch -> these fall back like a failed call
  }
  const results = IntentList.safeParse(parsed);
  if (!results.success) return out;
  for (const r of results.data.results) out.set(keywordKey(r.keyword), r.intent);
  return out;
}

function geminiRequest(apiKey: string, model: string, context: { clientName: string; websiteUrl: string }, items: unknown): Promise<Response> {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Client: ${context.clientName} (${context.websiteUrl})\n\nKeywords (JSON):\n${JSON.stringify(items)}`,
            },
          ],
        },
      ],
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
                  intent: { type: "STRING", enum: [...INTENTS] },
                },
                required: ["keyword", "intent"],
              },
            },
          },
          required: ["results"],
        },
      },
    }),
  });
}

const IntentList = z.object({
  results: z.array(z.object({ keyword: z.string(), intent: z.enum(INTENTS) })),
});

const BATCH_SIZE = 300;

async function classifyWithClaude(
  client: Anthropic,
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  toolLabels: Map<string, string[]>,
): Promise<Map<string, Intent>> {
  const out = new Map<string, Intent>();
  for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
    const items = batchItems(keywords.slice(i, i + BATCH_SIZE), toolLabels);
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(IntentList) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Client: ${context.clientName} (${context.websiteUrl})\n\nKeywords (JSON):\n${JSON.stringify(items)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) continue; // these fall back to patterns' default
    for (const r of response.parsed_output.results) out.set(keywordKey(r.keyword), r.intent);
  }
  return out;
}
