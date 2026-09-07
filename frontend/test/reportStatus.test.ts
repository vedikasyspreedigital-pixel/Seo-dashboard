import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDraftEditable,
  canRegenerate,
  canApproveOrReject,
  canDownloadReport,
  isReportFailed,
  isReportAlreadyBuilt,
  canGenerateEmailDraft,
  resolveSaveButtonLabel,
  buildReportDownloadFilename,
  isValidEmailAddress,
  parseRecipientsInput,
} from "../src/components/report/reportStatus.js";

// Pure logic driving the reports UI's action gating -- no DOM/network
// needed, matches this project's convention of unit-testing hand-rolled
// validation/state logic directly (see backend/reporting/*.ts and their tests).

test("isDraftEditable: only PENDING_APPROVAL is editable", () => {
  assert.equal(isDraftEditable("PENDING_APPROVAL"), true);
  for (const status of ["REPORT_READY", "EMAIL_DRAFTED", "APPROVED", "REJECTED", "SENT", "ANALYSIS_FAILED"] as const) {
    assert.equal(isDraftEditable(status), false, `expected ${status} to not be editable`);
  }
});

test("canRegenerate and canApproveOrReject: only PENDING_APPROVAL", () => {
  assert.equal(canRegenerate("PENDING_APPROVAL"), true);
  assert.equal(canApproveOrReject("PENDING_APPROVAL"), true);
  assert.equal(canRegenerate("SENT"), false);
  assert.equal(canApproveOrReject("REJECTED"), false);
  assert.equal(canApproveOrReject("REPORT_READY"), false);
});

test("canDownloadReport: true only when reportHtml is a non-empty string", () => {
  assert.equal(canDownloadReport("<html>report</html>"), true);
  assert.equal(canDownloadReport(""), false);
  assert.equal(canDownloadReport(null), false);
  assert.equal(canDownloadReport(undefined), false);
});

test("isReportFailed: only the two failure states", () => {
  assert.equal(isReportFailed("ANALYSIS_FAILED"), true);
  assert.equal(isReportFailed("EMAIL_DRAFT_FAILED"), true);
  assert.equal(isReportFailed("PENDING_APPROVAL"), false);
  assert.equal(isReportFailed("SENT"), false);
});

// FIX #2: Analytics Preview's action button must be state-aware -- it must
// only offer to Build Report when nothing has been built yet, so re-opening
// the page (e.g. via Back from PDF Preview) never re-fires a build and
// never risks the "not in a valid current state" class of error.
test("isReportAlreadyBuilt: false only before Build Report has ever run, true for every state from REPORT_READY onward", () => {
  for (const status of ["PENDING_ANALYSIS", "ANALYSIS_FAILED", "ANALYSIS_READY"] as const) {
    assert.equal(isReportAlreadyBuilt(status), false, `expected ${status} to not be built yet`);
  }
  for (const status of ["REPORT_READY", "EMAIL_DRAFT_FAILED", "EMAIL_DRAFTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT"] as const) {
    assert.equal(isReportAlreadyBuilt(status), true, `expected ${status} to already be built`);
  }
});

// FIX #2 regression: reproduced live -- PDF Preview -> Next: Email -> Back
// -> Next: Email again threw "cannot mark email drafted (REPORT_READY ->
// EMAIL_DRAFTED) -- not in a valid current state" because the button
// unconditionally called generate-email-draft. canGenerateEmailDraft is
// what the button now checks first.
test("canGenerateEmailDraft: true only at REPORT_READY -- once a draft exists (or failed), Next: Email must not re-call generate-email-draft", () => {
  assert.equal(canGenerateEmailDraft("REPORT_READY"), true);
  for (const status of ["PENDING_ANALYSIS", "ANALYSIS_FAILED", "ANALYSIS_READY", "EMAIL_DRAFT_FAILED", "EMAIL_DRAFTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT"] as const) {
    assert.equal(canGenerateEmailDraft(status), false, `expected ${status} to not allow generate-email-draft again`);
  }
});

// FIX #4 section 7: the Save Changes button's label must accurately reflect
// what actually happened -- "Saving..." only while the request is in
// flight, "Saved" only right after a real success AND while the form still
// matches what was persisted, and it must never claim "Saved" on a failed
// or not-yet-attempted save.
test("resolveSaveButtonLabel: saving always wins, regardless of justSaved/isDirty", () => {
  assert.equal(resolveSaveButtonLabel({ saving: true, justSaved: false, isDirty: false }), "Saving...");
  assert.equal(resolveSaveButtonLabel({ saving: true, justSaved: true, isDirty: true }), "Saving...");
});

test("resolveSaveButtonLabel: 'Saved' only when justSaved is true AND the form is not dirty", () => {
  assert.equal(resolveSaveButtonLabel({ saving: false, justSaved: true, isDirty: false }), "Saved");
});

test("resolveSaveButtonLabel: editing again after a save (isDirty becomes true) reverts away from 'Saved' -- it never lingers on top of new unsaved edits", () => {
  assert.equal(resolveSaveButtonLabel({ saving: false, justSaved: true, isDirty: true }), "Save Changes");
});

test("resolveSaveButtonLabel: default state (never saved, or a failed save) shows the plain label -- never falsely 'Saved'", () => {
  assert.equal(resolveSaveButtonLabel({ saving: false, justSaved: false, isDirty: false }), "Save Changes");
  assert.equal(resolveSaveButtonLabel({ saving: false, justSaved: false, isDirty: true }), "Save Changes");
});

test("buildReportDownloadFilename: stable, includes runId and a short report id", () => {
  const name = buildReportDownloadFilename({ id: "12345678-abcd-efgh-ijkl-mnopqrstuvwx", runId: "run-1" });
  assert.equal(name, "ranking-report-run-1-12345678.html");
});

test("isValidEmailAddress", () => {
  assert.equal(isValidEmailAddress("ops@example.com"), true);
  assert.equal(isValidEmailAddress("not-an-email"), false);
  assert.equal(isValidEmailAddress("missing-domain@"), false);
  assert.equal(isValidEmailAddress("@example.com"), false);
});

test("parseRecipientsInput: splits, trims, and buckets valid vs invalid entries", () => {
  const result = parseRecipientsInput(" a@example.com,  b@example.com ,not-an-email, ,c@example.com");
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
  assert.deepEqual(result.invalid, ["not-an-email"]);
});

test("parseRecipientsInput: empty input produces no recipients and no invalid entries", () => {
  const result = parseRecipientsInput("   ");
  assert.deepEqual(result.recipients, []);
  assert.deepEqual(result.invalid, []);
});
