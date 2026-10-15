import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { keywordKey } from "./readKeywordExport.js";

// Domain Intelligence: search intent for each keyword. Word patterns decide
// most keywords instantly and for free; only the ones no pattern matches go
// to Claude, in one batched call per report. With no ANTHROPIC_API_KEY (or if
// that call fails), those keywords fall back to "Informational" and are
// counted as unresolved so the summary can say so -- a missing key never
// blocks a report.

export const INTENTS = ["Informational", "Navigational", "Commercial", "Transactional"] as const;
export type Intent = (typeof INTENTS)[number];

export interface IntentResult {
  /** keywordKey(keyword) -> intent */
  intents: Map<string, Intent>;
  byPattern: number;
  byAi: number;
  /** Keywords neither patterns nor AI could label -- given the fallback. */
  unresolved: number;
}

const FALLBACK: Intent = "Informational";

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

export function classifyByPattern(keyword: string, brands: string[]): Intent | null {
  const k = keywordKey(keyword);
  const squashed = k.replace(/\s+/g, "");
  if (brands.some((b) => k.includes(b) || squashed.includes(b.replace(/\s+/g, "")))) return "Navigational";
  if (NAVIGATIONAL.test(k)) return "Navigational";
  if (QUESTION.test(k)) return "Informational";
  if (TRANSACTIONAL.test(k)) return "Transactional";
  if (COMMERCIAL.test(k)) return "Commercial";
  if (INFORMATIONAL.test(k)) return "Informational";
  return null;
}

export type ClassifyWithAiFn = (keywords: string[], context: { clientName: string; websiteUrl: string }) => Promise<Map<string, Intent>>;

export async function classifyIntents(
  keywords: string[],
  context: { clientName: string; websiteUrl: string },
  classifyWithAi: ClassifyWithAiFn | null = defaultAiClassifier(),
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
      const fromAi = await classifyWithAi(ambiguous, context);
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

  let unresolved = 0;
  for (const keyword of ambiguous) {
    if (!intents.has(keywordKey(keyword))) {
      intents.set(keywordKey(keyword), FALLBACK);
      unresolved++;
    }
  }
  return { intents, byPattern, byAi, unresolved };
}

/** Claude-backed classifier, or null when no API key is configured. */
export function defaultAiClassifier(): ClassifyWithAiFn | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return (keywords, context) => classifyWithClaude(client, keywords, context);
}

const IntentList = z.object({
  results: z.array(z.object({ keyword: z.string(), intent: z.enum(INTENTS) })),
});

const BATCH_SIZE = 300;

async function classifyWithClaude(client: Anthropic, keywords: string[], context: { clientName: string; websiteUrl: string }): Promise<Map<string, Intent>> {
  const out = new Map<string, Intent>();
  for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
    const batch = keywords.slice(i, i + BATCH_SIZE);
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(IntentList) },
      system:
        "You label the search intent of SEO keywords. Use exactly one of: Informational (wants information or an answer), " +
        "Navigational (looking for a specific brand or website), Commercial (researching or comparing options before deciding), " +
        "Transactional (ready to book, buy, hire or act). Return every keyword exactly as given.",
      messages: [
        {
          role: "user",
          content: `Client: ${context.clientName} (${context.websiteUrl})\n\nKeywords, one per line:\n${batch.join("\n")}`,
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) continue; // these fall back to patterns' default
    for (const r of response.parsed_output.results) out.set(keywordKey(r.keyword), r.intent);
  }
  return out;
}
