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

  assert.equal(result.subject, "SEO Ranking Report – Aug 1, 2026 to Sep 1, 2026");
  assert.ok(result.bodyText.includes("Aug 1, 2026 - Sep 1, 2026"));
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

test("buildDefaultEmailDraft never varies by client name -- the template is universal, not personalized text", () => {
  const period = { periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01") };
  const a = buildDefaultEmailDraft({ clientName: "Acme", ...period });
  const b = buildDefaultEmailDraft({ clientName: "Widgets Inc", ...period });
  assert.equal(a.bodyText, b.bodyText, "the client name is not referenced in the body -- 'Dear Client' is generic on purpose");
  assert.equal(a.subject, b.subject);
});
