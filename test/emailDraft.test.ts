import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDefaultEmailDraft } from "../backend/reporting/emailDraft.js";

// Pure unit tests -- no DB, no network, no AI call. buildDefaultEmailDraft is
// a deterministic template fill: same input always produces the same output.

test("buildDefaultEmailDraft fills the standard template with the formatted period dates", () => {
  const result = buildDefaultEmailDraft({
    clientName: "Cash For Cars Perth",
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-09-01T00:00:00Z"),
  });

  assert.equal(result.subject, "Cash For Cars Perth Keyword Ranking Report 1st August 2026 - 1st September 2026");
  assert.ok(result.bodyText.includes("1st August 2026 - 1st September 2026"));
  assert.ok(result.bodyText.startsWith("Dear Client,"));
  assert.ok(result.bodyText.includes("TEAM SySpree"));
  assert.ok(result.bodyText.includes("support@syspreesolutions.com"));
});

test("buildDefaultEmailDraft is deterministic -- same input, same output, every time", () => {
  const input = { clientName: "Acme", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01") };
  const first = buildDefaultEmailDraft(input);
  const second = buildDefaultEmailDraft(input);
  assert.deepEqual(first, second);
});

test("buildDefaultEmailDraft: the subject leads with the client's name, but the body stays generic ('Dear Client')", () => {
  const period = { periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01") };
  const a = buildDefaultEmailDraft({ clientName: "Acme", ...period });
  const b = buildDefaultEmailDraft({ clientName: "Widgets Inc", ...period });
  assert.equal(a.bodyText, b.bodyText, "the body never references the client name -- 'Dear Client' is generic on purpose");
  assert.notEqual(a.subject, b.subject, "the subject must lead with the client's own name");
  assert.equal(a.subject, "Acme Keyword Ranking Report 1st January 2026 - 1st February 2026");
  assert.equal(b.subject, "Widgets Inc Keyword Ranking Report 1st January 2026 - 1st February 2026");
});
