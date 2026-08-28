import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDraftEditable,
  canRegenerate,
  canApproveOrReject,
  canDownloadReport,
  isReportFailed,
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
