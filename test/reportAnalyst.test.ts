import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalystInput, validateAnalystOutput, runReportAnalyst, type AnalystInput } from "../backend/reporting/reportAnalyst.js";
import { createMockClaudeAnalyst } from "../backend/reporting/mockClaudeClient.js";
import type { RunAnalytics } from "../backend/reporting/computeRunAnalytics.js";

// Pure unit tests -- no DB, no network, no Claude call.

const SAMPLE_ANALYTICS: RunAnalytics = {
  runId: "run-1",
  previousRunId: "run-0",
  totals: { totalKeywords: 4, averageRank: 12.5, top3Count: 1, top10Count: 2, notIn100Count: 1 },
  movements: {
    improved: [{ keyword: "cash for cars perth", rowUid: "uid-1", previousRank: 9, currentRank: 2, delta: 7 }],
    declined: [{ keyword: "car removal perth", rowUid: "uid-2", previousRank: 5, currentRank: 20, delta: -15 }],
    unchanged: [{ keyword: "car wreckers", rowUid: "uid-3", previousRank: null, currentRank: null, delta: null }],
    newlyTracked: [{ keyword: "toyota wreckers", rowUid: "uid-4", currentRank: 30 }],
  },
};

test("buildAnalystInput maps totals and movements into the exact Claude input shape", () => {
  const input = buildAnalystInput({
    clientName: "Cash For Cars Perth",
    analytics: SAMPLE_ANALYTICS,
    config: { reportTone: "professional", sectionsEnabled: ["summary", "wins"], customInstructions: "Focus on Rockingham." },
    period: { from: "2026-08-13", to: "2026-08-20" },
  });

  assert.equal(input.client.name, "Cash For Cars Perth");
  assert.deepEqual(input.summary, { totalKeywords: 4, averageRank: 12.5, top3: 1, top10: 2, notIn100: 1 });
  assert.equal(input.movements.improved[0].keyword, "cash for cars perth");
  assert.equal(input.movements.improved[0].delta, 7);
  assert.equal(input.movements.newlyTracked[0].keyword, "toyota wreckers");
  assert.equal(input.clientInstructions.tone, "professional");
  assert.deepEqual(input.clientInstructions.sectionsToInclude, ["summary", "wins"]);
  assert.equal(input.clientInstructions.customNotes, "Focus on Rockingham.");
});

test("buildAnalystInput falls back to defaults when no client config is given", () => {
  const input = buildAnalystInput({
    clientName: "New Client",
    analytics: SAMPLE_ANALYTICS,
    config: null,
    period: { from: "2026-08-13", to: "2026-08-20" },
  });
  assert.equal(input.clientInstructions.tone, "professional");
  assert.deepEqual(input.clientInstructions.sectionsToInclude, ["summary", "wins", "losses", "recommendations"]);
  assert.equal(input.clientInstructions.customNotes, undefined);
});

const ALLOWED_KEYWORDS = new Set(["cash for cars perth", "car removal perth", "car wreckers", "toyota wreckers"]);

function validOutput() {
  return {
    overallNarrative: "Solid week overall.",
    keyInsights: ["2 keywords rank in the top 10."],
    notableWins: [{ keyword: "cash for cars perth", note: "Moved from 9 to 2." }],
    notableLosses: [{ keyword: "car removal perth", note: "Dropped from 5 to 20." }],
    recommendedFocusAreas: ["car removal perth"],
  };
}

test("validateAnalystOutput accepts a well-formed, keyword-consistent output", () => {
  const result = validateAnalystOutput(validOutput(), ALLOWED_KEYWORDS);
  assert.equal(result.valid, true);
});

test("validateAnalystOutput rejects a missing required field", () => {
  const bad = validOutput() as Record<string, unknown>;
  delete bad.overallNarrative;
  const result = validateAnalystOutput(bad, ALLOWED_KEYWORDS);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("overallNarrative")));
});

test("validateAnalystOutput rejects an oversized array", () => {
  const bad = validOutput();
  bad.keyInsights = ["a", "b", "c", "d", "e", "f"]; // 6 > max 5
  const result = validateAnalystOutput(bad, ALLOWED_KEYWORDS);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("keyInsights")));
});

test("validateAnalystOutput rejects an invented keyword not present in the input -- this is the core safety check", () => {
  const bad = validOutput();
  bad.notableWins = [{ keyword: "made up keyword that was never tracked", note: "Great result!" }];
  const result = validateAnalystOutput(bad, ALLOWED_KEYWORDS);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("made up keyword")));
});

test("runReportAnalyst: SUCCESS when the mock client returns a valid, consistent output", async () => {
  const input = buildAnalystInput({ clientName: "Test Client", analytics: SAMPLE_ANALYTICS, config: null, period: { from: "a", to: "b" } });
  const result = await runReportAnalyst(input, createMockClaudeAnalyst());
  assert.equal(result.outcome, "SUCCESS");
  if (result.outcome === "SUCCESS") {
    assert.equal(result.data.notableWins[0].keyword, "cash for cars perth");
  }
});

test("runReportAnalyst: CALL_ERROR when the injected Claude client throws", async () => {
  const input = buildAnalystInput({ clientName: "Test Client", analytics: SAMPLE_ANALYTICS, config: null, period: { from: "a", to: "b" } });
  const throwingClient = async (_input: AnalystInput) => {
    throw new Error("model unavailable");
  };
  const result = await runReportAnalyst(input, throwingClient);
  assert.equal(result.outcome, "CALL_ERROR");
  if (result.outcome === "CALL_ERROR") assert.equal(result.errorMessage, "model unavailable");
});

test("runReportAnalyst: VALIDATION_ERROR when the client returns a schema-invalid output", async () => {
  const input = buildAnalystInput({ clientName: "Test Client", analytics: SAMPLE_ANALYTICS, config: null, period: { from: "a", to: "b" } });
  const badClient = async (_input: AnalystInput) => ({ overallNarrative: "ok" }); // missing required fields
  const result = await runReportAnalyst(input, badClient);
  assert.equal(result.outcome, "VALIDATION_ERROR");
});

test("runReportAnalyst: VALIDATION_ERROR when the client invents a keyword not in the input", async () => {
  const input = buildAnalystInput({ clientName: "Test Client", analytics: SAMPLE_ANALYTICS, config: null, period: { from: "a", to: "b" } });
  const hallucinatingClient = async (_input: AnalystInput) => ({
    ...validOutput(),
    notableWins: [{ keyword: "a keyword nobody tracked", note: "Amazing!" }],
  });
  const result = await runReportAnalyst(input, hallucinatingClient);
  assert.equal(result.outcome, "VALIDATION_ERROR");
  if (result.outcome === "VALIDATION_ERROR") {
    assert.ok(result.errors.some((e) => e.includes("a keyword nobody tracked")));
  }
});
