import type { RunAnalytics } from "./computeRunAnalytics.js";
import type { AnalystOutput } from "./reportAnalyst.js";

// The structured contract for the Claude Email Draft Generator. Deliberately
// narrower than the Report Analyst's input: headline metrics + key insights
// only, never the full movements table, and -- critically -- never any
// recipient information. Recipients are resolved by the backend from
// ClientReportConfig, always, and Claude's output is validated to reject
// any field beyond subject/bodyText/bodyHtml, so it structurally cannot
// smuggle recipient data back through an unexpected key either.

export interface EmailDraftInput {
  client: { name: string };
  reportSummary: {
    totalKeywords: number;
    averageRank: number | null;
    top3: number;
    top10: number;
    notIn100: number;
  };
  keyInsights: string[];
  tone: string;
}

export interface EmailDraftOutput {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}

export type CallClaudeEmailDraftFn = (input: EmailDraftInput) => Promise<unknown>;

export type RunEmailDraftGeneratorResult =
  | { outcome: "SUCCESS"; data: EmailDraftOutput }
  | { outcome: "VALIDATION_ERROR"; errors: string[] }
  | { outcome: "CALL_ERROR"; errorMessage: string };

export function buildEmailDraftInput({
  clientName,
  analytics,
  analysis,
  tone,
}: {
  clientName: string;
  analytics: RunAnalytics;
  // null when the report reached REPORT_READY via the Build Report shortcut
  // (PENDING_ANALYSIS -> REPORT_READY), skipping the optional Claude
  // Insights step -- the email draft still gets the deterministic summary,
  // just no keyInsights bullets to work from.
  analysis: AnalystOutput | null;
  tone: string;
}): EmailDraftInput {
  return {
    client: { name: clientName },
    reportSummary: {
      totalKeywords: analytics.totals.totalKeywords,
      averageRank: analytics.totals.averageRank,
      top3: analytics.totals.top3Count,
      top10: analytics.totals.top10Count,
      notIn100: analytics.totals.notIn100Count,
    },
    keyInsights: analysis?.keyInsights ?? [],
    tone,
  };
}

const ALLOWED_OUTPUT_KEYS = new Set(["subject", "bodyText", "bodyHtml"]);

/**
 * Structural validation, hand-rolled like validateAnalystOutput. Any key
 * other than subject/bodyText/bodyHtml is rejected outright -- this is the
 * enforced half of "Claude must never determine recipient addresses": even
 * if a model tried to return a `recipients`/`to`/`cc` field, it fails
 * validation here and is never read by anything downstream.
 */
export function validateEmailDraftOutput(raw: unknown): { valid: true; data: EmailDraftOutput } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { valid: false, errors: ["Output is not an object"] };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_OUTPUT_KEYS.has(key)) {
      errors.push(`Unexpected field "${key}" -- email draft output may only contain subject, bodyText, bodyHtml (never recipients)`);
    }
  }

  if (typeof obj.subject !== "string" || obj.subject.length === 0) {
    errors.push("subject must be a non-empty string");
  } else if (obj.subject.length > 120) {
    errors.push("subject exceeds 120 characters");
  }

  if (typeof obj.bodyText !== "string" || obj.bodyText.length === 0) {
    errors.push("bodyText must be a non-empty string");
  }

  if (obj.bodyHtml !== undefined && typeof obj.bodyHtml !== "string") {
    errors.push("bodyHtml must be a string when present");
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: obj as unknown as EmailDraftOutput };
}

/**
 * Orchestrates one Email Draft Generator call: invoke the injected Claude
 * client, then validate its output before trusting any of it. Same
 * dependency-injection shape as runReportAnalyst -- tests never need a real
 * Claude call.
 */
export async function runEmailDraftGenerator(
  input: EmailDraftInput,
  callClaude: CallClaudeEmailDraftFn,
): Promise<RunEmailDraftGeneratorResult> {
  let raw: unknown;
  try {
    raw = await callClaude(input);
  } catch (err) {
    return { outcome: "CALL_ERROR", errorMessage: (err as Error).message };
  }

  const validation = validateEmailDraftOutput(raw);
  if (!validation.valid) {
    return { outcome: "VALIDATION_ERROR", errors: validation.errors };
  }
  return { outcome: "SUCCESS", data: validation.data };
}
