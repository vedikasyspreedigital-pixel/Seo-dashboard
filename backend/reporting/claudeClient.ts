import type { AnalystInput } from "./reportAnalyst.js";
import type { EmailDraftInput } from "./emailDraft.js";

// The REAL Claude callers (Report Analyst + Email Draft Generator). Written
// for completeness of the design but never invoked by this codebase's tests
// or any wired-up route -- there is no ANTHROPIC_API_KEY configured, and
// nothing calls these functions yet. When a real call is wanted, inject one
// of these (not the mock) into runReportAnalyst/runEmailDraftGenerator explicitly.

export const ANALYST_SYSTEM_PROMPT = `You are a Report Analyst for an SEO ranking dashboard. You will receive pre-computed ranking metrics as JSON -- totals, averages, and keyword movements are already calculated; do not recompute, second-guess, or invent any number not present in the input. Do not reference any keyword that is not present in the input. Write interpretation and narrative only, following the client's tone and instructions. Respond only via the submit_analysis tool.`;

export const ANALYST_OUTPUT_SCHEMA = {
  type: "object",
  required: ["overallNarrative", "keyInsights", "notableWins", "notableLosses", "recommendedFocusAreas"],
  additionalProperties: false,
  properties: {
    overallNarrative: { type: "string", maxLength: 800 },
    keyInsights: { type: "array", items: { type: "string" }, maxItems: 5 },
    notableWins: {
      type: "array",
      items: {
        type: "object",
        required: ["keyword", "note"],
        additionalProperties: false,
        properties: { keyword: { type: "string" }, note: { type: "string" } },
      },
    },
    notableLosses: {
      type: "array",
      items: {
        type: "object",
        required: ["keyword", "note"],
        additionalProperties: false,
        properties: { keyword: { type: "string" }, note: { type: "string" } },
      },
    },
    recommendedFocusAreas: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
} as const;

export const EMAIL_DRAFT_SYSTEM_PROMPT = `You draft a short client-facing email summarizing an SEO ranking report that has already been generated. You are given only the report's headline metrics and the analyst's key insights -- not the full report, and never the client's recipient list. You have no ability to decide whether or to whom this is sent, and your output must never contain a recipient, "to", or "cc" field of any kind. Respond only via the submit_email_draft tool.`;

export const EMAIL_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["subject", "bodyText"],
  additionalProperties: false,
  properties: {
    subject: { type: "string", maxLength: 120 },
    bodyText: { type: "string" },
    bodyHtml: { type: "string" },
  },
} as const;

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

async function callClaudeWithForcedTool(options: {
  apiKey: string;
  system: string;
  userContent: string;
  toolName: string;
  toolDescription: string;
  inputSchema: unknown;
}): Promise<unknown> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: options.system,
      messages: [{ role: "user", content: options.userContent }],
      tools: [{ name: options.toolName, description: options.toolDescription, input_schema: options.inputSchema }],
      tool_choice: { type: "tool", name: options.toolName },
    }),
  });

  const body = (await response.json()) as { content?: unknown[] };
  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${JSON.stringify(body)}`);
  }

  const content: unknown[] = Array.isArray(body.content) ? body.content : [];
  const toolUse = content.find(
    (block): block is ToolUseBlock =>
      typeof block === "object" && block !== null && (block as ToolUseBlock).type === "tool_use" && (block as ToolUseBlock).name === options.toolName,
  );
  if (!toolUse) {
    throw new Error(`Claude did not return a ${options.toolName} tool call`);
  }
  return toolUse.input;
}

export async function callClaudeReportAnalystLive(input: AnalystInput): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set (see serp-interpreter/.env)");
  }
  return callClaudeWithForcedTool({
    apiKey,
    system: ANALYST_SYSTEM_PROMPT,
    userContent: `${JSON.stringify(input)}\n\nAnalyze this ranking data for the period shown and produce insights per the schema.`,
    toolName: "submit_analysis",
    toolDescription: "Submit the structured ranking analysis.",
    inputSchema: ANALYST_OUTPUT_SCHEMA,
  });
}

// Note this input intentionally carries no recipient information at all --
// EmailDraftInput has no such field, so there is nothing here for Claude to
// read or decide about who receives this email.
export async function callClaudeEmailDraftLive(input: EmailDraftInput): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set (see serp-interpreter/.env)");
  }
  return callClaudeWithForcedTool({
    apiKey,
    system: EMAIL_DRAFT_SYSTEM_PROMPT,
    userContent: `${JSON.stringify(input)}\n\nDraft a short client-facing email summarizing this report per the schema.`,
    toolName: "submit_email_draft",
    toolDescription: "Submit the drafted email subject and body.",
    inputSchema: EMAIL_DRAFT_OUTPUT_SCHEMA,
  });
}
