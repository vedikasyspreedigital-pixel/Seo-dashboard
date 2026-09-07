import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmailDraftInput, validateEmailDraftOutput, runEmailDraftGenerator, type EmailDraftInput } from "../backend/reporting/emailDraft.js";
import { createMockClaudeEmailDrafter } from "../backend/reporting/mockClaudeClient.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";
import type { AnalystOutput } from "../backend/reporting/reportAnalyst.js";

// Pure unit tests -- no DB, no network, no Claude call.

const ANALYTICS: RunAnalytics = {
  runId: "run-1",
  previousRunId: null,
  totals: { totalKeywords: 5, averageRank: 14.3, top3Count: 0, top10Count: 2, notIn100Count: 3 },
  movements: { improved: [], declined: [], unchanged: [], newlyTracked: [] },
};

const ANALYSIS: AnalystOutput = {
  overallNarrative: "A steady period.",
  keyInsights: ["2 keywords rank in the top 10.", "3 keywords are not ranking in the top 100."],
  notableWins: [],
  notableLosses: [],
  recommendedFocusAreas: [],
};

test("buildEmailDraftInput carries only headline metrics + key insights + tone -- no recipients, no full movements table", () => {
  const input = buildEmailDraftInput({ clientName: "Cash For Cars Perth", analytics: ANALYTICS, analysis: ANALYSIS, tone: "casual" });

  assert.equal(input.client.name, "Cash For Cars Perth");
  assert.deepEqual(input.reportSummary, { totalKeywords: 5, averageRank: 14.3, top3: 0, top10: 2, notIn100: 3 });
  assert.deepEqual(input.keyInsights, ANALYSIS.keyInsights);
  assert.equal(input.tone, "casual");

  // Structural proof there is nowhere for recipient data to even live.
  const allKeys = new Set(Object.keys(input));
  for (const forbidden of ["recipients", "to", "cc", "bcc", "email", "emails", "resolvedRecipients"]) {
    assert.equal(allKeys.has(forbidden), false, `EmailDraftInput must not contain "${forbidden}"`);
  }
  assert.deepEqual(Object.keys(input).sort(), ["client", "keyInsights", "reportSummary", "tone"]);
});

test("buildEmailDraftInput: analysis === null (Build Report shortcut skipped Claude Insights) still produces a valid input, with empty keyInsights", () => {
  const input = buildEmailDraftInput({ clientName: "Cash For Cars Perth", analytics: ANALYTICS, analysis: null, tone: "casual" });

  assert.deepEqual(input.reportSummary, { totalKeywords: 5, averageRank: 14.3, top3: 0, top10: 2, notIn100: 3 });
  assert.deepEqual(input.keyInsights, []);
});

function validOutput() {
  return {
    subject: "Your weekly ranking update",
    bodyText: "Hi, here's how things went this week.",
    bodyHtml: "<p>Hi, here's how things went this week.</p>",
  };
}

test("validateEmailDraftOutput accepts a well-formed output with all three fields", () => {
  const result = validateEmailDraftOutput(validOutput());
  assert.equal(result.valid, true);
});

test("validateEmailDraftOutput accepts bodyHtml being omitted (only subject/bodyText required)", () => {
  const { bodyHtml, ...withoutHtml } = validOutput();
  const result = validateEmailDraftOutput(withoutHtml);
  assert.equal(result.valid, true);
});

test("validateEmailDraftOutput rejects a missing subject or bodyText", () => {
  const missingSubject = validOutput() as Record<string, unknown>;
  delete missingSubject.subject;
  const result = validateEmailDraftOutput(missingSubject);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("subject")));
});

test("validateEmailDraftOutput rejects an oversized subject", () => {
  const bad = validOutput();
  bad.subject = "x".repeat(121);
  const result = validateEmailDraftOutput(bad);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("subject")));
});

test("validateEmailDraftOutput rejects an attempted recipients field -- this is the enforced safety check", () => {
  const bad = { ...validOutput(), recipients: ["someone@example.com"] };
  const result = validateEmailDraftOutput(bad);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes('"recipients"')));
});

test("validateEmailDraftOutput rejects a 'to' field the same way", () => {
  const bad = { ...validOutput(), to: "someone@example.com" };
  const result = validateEmailDraftOutput(bad);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes('"to"')));
});

test("runEmailDraftGenerator: SUCCESS with the mock client", async () => {
  const input = buildEmailDraftInput({ clientName: "Cash For Cars Perth", analytics: ANALYTICS, analysis: ANALYSIS, tone: "professional" });
  const result = await runEmailDraftGenerator(input, createMockClaudeEmailDrafter());
  assert.equal(result.outcome, "SUCCESS");
  if (result.outcome === "SUCCESS") {
    assert.ok(result.data.subject.includes("Cash For Cars Perth"));
    assert.ok(result.data.bodyText.length > 0);
  }
});

test("runEmailDraftGenerator: CALL_ERROR when the injected Claude client throws", async () => {
  const input = buildEmailDraftInput({ clientName: "X", analytics: ANALYTICS, analysis: ANALYSIS, tone: "professional" });
  const throwingClient = async (_input: EmailDraftInput) => {
    throw new Error("model unavailable");
  };
  const result = await runEmailDraftGenerator(input, throwingClient);
  assert.equal(result.outcome, "CALL_ERROR");
  if (result.outcome === "CALL_ERROR") assert.equal(result.errorMessage, "model unavailable");
});

test("runEmailDraftGenerator: VALIDATION_ERROR when the client returns a schema-invalid output", async () => {
  const input = buildEmailDraftInput({ clientName: "X", analytics: ANALYTICS, analysis: ANALYSIS, tone: "professional" });
  const badClient = async (_input: EmailDraftInput) => ({ subject: "" }); // missing bodyText, empty subject
  const result = await runEmailDraftGenerator(input, badClient);
  assert.equal(result.outcome, "VALIDATION_ERROR");
});

test("runEmailDraftGenerator: VALIDATION_ERROR when the client tries to include recipients", async () => {
  const input = buildEmailDraftInput({ clientName: "X", analytics: ANALYTICS, analysis: ANALYSIS, tone: "professional" });
  const sneakyClient = async (_input: EmailDraftInput) => ({ ...validOutput(), recipients: ["hacked@example.com"] });
  const result = await runEmailDraftGenerator(input, sneakyClient);
  assert.equal(result.outcome, "VALIDATION_ERROR");
  if (result.outcome === "VALIDATION_ERROR") assert.ok(result.errors.some((e) => e.includes("recipients")));
});
