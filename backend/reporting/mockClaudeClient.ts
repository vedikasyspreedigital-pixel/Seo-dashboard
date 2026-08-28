import type { AnalystInput, CallClaudeFn } from "./reportAnalyst.js";
import type { EmailDraftInput, CallClaudeEmailDraftFn } from "./emailDraft.js";

// Deterministic mocks -- never make a network call. The analyst mock
// derives its narrative entirely from the real input data, so it naturally
// passes the "no invented keywords" validation. The email draft mock never
// even has recipient information available to it, since EmailDraftInput
// has no such field.

export function createMockClaudeAnalyst(): CallClaudeFn {
  return async function mockCallClaude(input: AnalystInput) {
    const topImproved = input.movements.improved[0];
    const topDeclined = input.movements.declined[0];

    return {
      overallNarrative:
        input.summary.averageRank !== null
          ? `Tracked ${input.summary.totalKeywords} keyword(s) this period, averaging position ${input.summary.averageRank}.`
          : `Tracked ${input.summary.totalKeywords} keyword(s) this period; none currently rank in the top 100.`,
      keyInsights: [
        `${input.summary.top10} keyword(s) rank in the top 10.`,
        `${input.summary.notIn100} keyword(s) are not ranking in the top 100.`,
      ],
      notableWins: topImproved
        ? [
            {
              keyword: topImproved.keyword,
              note: `Moved from ${topImproved.previousRank ?? "Not in 100"} to ${topImproved.currentRank ?? "Not in 100"}.`,
            },
          ]
        : [],
      notableLosses: topDeclined
        ? [
            {
              keyword: topDeclined.keyword,
              note: `Moved from ${topDeclined.previousRank ?? "Not in 100"} to ${topDeclined.currentRank ?? "Not in 100"}.`,
            },
          ]
        : [],
      recommendedFocusAreas: topDeclined ? [topDeclined.keyword] : [],
    };
  };
}

export function createMockClaudeEmailDrafter(): CallClaudeEmailDraftFn {
  return async function mockCallClaudeEmailDraft(input: EmailDraftInput) {
    const insightsLine = input.keyInsights.length > 0 ? input.keyInsights.join(" ") : "No major changes this period.";
    return {
      subject: `Your ranking update for ${input.client.name}`,
      bodyText: `Hi,\n\nHere's a quick summary for this period: ${insightsLine}\n\nThe full report is attached.`,
      bodyHtml: `<p>Hi,</p><p>Here's a quick summary for this period: ${insightsLine}</p><p>The full report is attached.</p>`,
    };
  };
}
