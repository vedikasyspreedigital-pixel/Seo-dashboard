import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClickUpEmailSender } from "../backend/reporting/clickupEmailSender.js";

// Regression test for the exact property required by the live ClickUp
// debugging session this file came out of: a broken/missing "Comment" UI
// must NEVER prevent a successfully-sent, verified email from being
// reported as sent. Runs a REAL headless Chromium (via the real
// createClickUpEmailSender -- no mocking of the automation itself) against
// a local static fixture standing in for ClickUp's task view, so this
// exercises the actual selector/flow logic without touching live ClickUp.
//
// The fixture (test/fixtures/fake-clickup-composer.html) starts already in
// Email mode and deliberately has NO element anywhere matching
// postAuditComment's "switch to Comment mode" lookup, plus a second,
// unclickable (display:none) .ql-editor outside the composer root -- the
// exact DOM shape you'd see if that mode-switch-back had failed/never
// existed. If this test passes, the send succeeded and was reported
// successfully DESPITE that.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = pathToFileURL(path.join(__dirname, "fixtures", "fake-clickup-composer.html")).href;
const EMPTY_STORAGE_STATE = path.join(__dirname, "fixtures", "clickup-storage-state.json");

test("sendViaClickUp succeeds and reports auditCommentPosted:false when the Comment UI is entirely unavailable", async () => {
  const sendEmail = createClickUpEmailSender({
    sessionStatePath: EMPTY_STORAGE_STATE,
    headless: true,
  });

  const result = await sendEmail({
    to: ["ops@example.com"],
    subject: `regression-test-subject-${Date.now()}`,
    bodyText: "This is the report body.",
    clickupTaskUrl: FIXTURE_URL,
  });

  // The send itself must be reported as successful -- a real messageId,
  // not a thrown SEND_FAILED-style error -- even though the audit-comment
  // step below necessarily failed against this fixture.
  assert.ok(result.messageId, "expected a messageId, meaning the send was verified successful");
  assert.equal(result.auditCommentPosted, false, "the audit comment must be reported as failed (not thrown, not silently true) given the fixture has no working Comment UI");
});
