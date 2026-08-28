import type { RunAnalytics } from "./computeRunAnalytics.js";

// The structured contract between our backend and the Claude Report
// Analyst. Claude receives ONLY this pre-computed shape -- every number in
// `summary`/`movements` came from computeRunAnalytics, never from Claude --
// and must return exactly AnalystOutput, validated before anything trusts it.

export interface AnalystMovementEntry {
  keyword: string;
  previousRank: number | null;
  currentRank: number | null;
  delta?: number | null;
}

export interface AnalystInput {
  client: { name: string };
  reportingPeriod: { from: string; to: string };
  summary: {
    totalKeywords: number;
    averageRank: number | null;
    top3: number;
    top10: number;
    notIn100: number;
  };
  movements: {
    improved: AnalystMovementEntry[];
    declined: AnalystMovementEntry[];
    unchanged: AnalystMovementEntry[];
    newlyTracked: { keyword: string; currentRank: number | null }[];
  };
  clientInstructions: {
    tone: string;
    sectionsToInclude: string[];
    customNotes?: string;
  };
}

export interface AnalystOutput {
  overallNarrative: string;
  keyInsights: string[];
  notableWins: { keyword: string; note: string }[];
  notableLosses: { keyword: string; note: string }[];
  recommendedFocusAreas: string[];
}

export type CallClaudeFn = (input: AnalystInput) => Promise<unknown>;

export type RunReportAnalystResult =
  | { outcome: "SUCCESS"; data: AnalystOutput }
  | { outcome: "VALIDATION_ERROR"; errors: string[] }
  | { outcome: "CALL_ERROR"; errorMessage: string };

interface ClientReportConfigLike {
  reportTone: string;
  sectionsEnabled: unknown;
  customInstructions?: string | null;
}

/** Adapts computeRunAnalytics' output + client config into Claude's exact input contract. */
export function buildAnalystInput({
  clientName,
  analytics,
  config,
  period,
}: {
  clientName: string;
  analytics: RunAnalytics;
  config?: ClientReportConfigLike | null;
  period: { from: string; to: string };
}): AnalystInput {
  return {
    client: { name: clientName },
    reportingPeriod: period,
    summary: {
      totalKeywords: analytics.totals.totalKeywords,
      averageRank: analytics.totals.averageRank,
      top3: analytics.totals.top3Count,
      top10: analytics.totals.top10Count,
      notIn100: analytics.totals.notIn100Count,
    },
    movements: {
      improved: analytics.movements.improved.map((m) => ({
        keyword: m.keyword,
        previousRank: m.previousRank,
        currentRank: m.currentRank,
        delta: m.delta,
      })),
      declined: analytics.movements.declined.map((m) => ({
        keyword: m.keyword,
        previousRank: m.previousRank,
        currentRank: m.currentRank,
        delta: m.delta,
      })),
      unchanged: analytics.movements.unchanged.map((m) => ({
        keyword: m.keyword,
        previousRank: m.previousRank,
        currentRank: m.currentRank,
      })),
      newlyTracked: analytics.movements.newlyTracked.map((m) => ({
        keyword: m.keyword,
        currentRank: m.currentRank,
      })),
    },
    clientInstructions: {
      tone: config?.reportTone ?? "professional",
      sectionsToInclude: Array.isArray(config?.sectionsEnabled)
        ? (config!.sectionsEnabled as string[])
        : ["summary", "wins", "losses", "recommendations"],
      customNotes: config?.customInstructions ?? undefined,
    },
  };
}

function collectKeywords(input: AnalystInput): Set<string> {
  const keywords = new Set<string>();
  for (const m of input.movements.improved) keywords.add(m.keyword);
  for (const m of input.movements.declined) keywords.add(m.keyword);
  for (const m of input.movements.unchanged) keywords.add(m.keyword);
  for (const m of input.movements.newlyTracked) keywords.add(m.keyword);
  return keywords;
}

function isStringArray(value: unknown, maxItems?: number): value is string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return false;
  return maxItems === undefined || value.length <= maxItems;
}

/**
 * Structural validation of Claude's tool-call output, hand-rolled (no
 * schema-validation library) to match this project's existing style
 * (backend/dataforseo/mapResponse.js validates DataForSEO shapes the same
 * way). Crucially also cross-checks every keyword Claude names against the
 * keywords actually present in the input -- an invented keyword fails
 * validation, it is never silently displayed.
 */
export function validateAnalystOutput(
  raw: unknown,
  allowedKeywords: Set<string>,
): { valid: true; data: AnalystOutput } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { valid: false, errors: ["Output is not an object"] };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.overallNarrative !== "string" || obj.overallNarrative.length === 0) {
    errors.push("overallNarrative must be a non-empty string");
  } else if (obj.overallNarrative.length > 800) {
    errors.push("overallNarrative exceeds 800 characters");
  }

  if (!isStringArray(obj.keyInsights, 5)) {
    errors.push("keyInsights must be an array of at most 5 strings");
  }

  const validateNoteList = (value: unknown, name: string) => {
    if (!Array.isArray(value)) {
      errors.push(`${name} must be an array`);
      return;
    }
    for (const item of value) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as Record<string, unknown>).keyword !== "string" ||
        typeof (item as Record<string, unknown>).note !== "string"
      ) {
        errors.push(`${name} items must each have a string keyword and note`);
        continue;
      }
      const keyword = (item as Record<string, unknown>).keyword as string;
      if (!allowedKeywords.has(keyword)) {
        errors.push(`${name} references "${keyword}", which is not one of the input's tracked keywords`);
      }
    }
  };
  validateNoteList(obj.notableWins, "notableWins");
  validateNoteList(obj.notableLosses, "notableLosses");

  if (!isStringArray(obj.recommendedFocusAreas, 5)) {
    errors.push("recommendedFocusAreas must be an array of at most 5 strings");
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: obj as unknown as AnalystOutput };
}

/**
 * Orchestrates one Report Analyst call: invoke the injected Claude client,
 * then validate its output before trusting any of it. `callClaude` is
 * injected so tests never need a real Claude call -- see mockClaudeClient.ts.
 */
export async function runReportAnalyst(input: AnalystInput, callClaude: CallClaudeFn): Promise<RunReportAnalystResult> {
  let raw: unknown;
  try {
    raw = await callClaude(input);
  } catch (err) {
    return { outcome: "CALL_ERROR", errorMessage: (err as Error).message };
  }

  const validation = validateAnalystOutput(raw, collectKeywords(input));
  if (!validation.valid) {
    return { outcome: "VALIDATION_ERROR", errors: validation.errors };
  }
  return { outcome: "SUCCESS", data: validation.data };
}
