import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunReportable, isRunCancelable } from "../src/components/run/runStatus.js";
import { getExportUrl } from "../src/api/client.js";
import type { RunStatus } from "../src/api/types.js";

// FIX #3: the Run Detail action area's visibility rules, driven entirely by
// the backend-reported RunStatus (never progress %, row counts, or a
// timer). These pure functions are exactly what the Generate Report /
// Download Excel / Cancel buttons gate on, so testing them directly proves
// the visibility rule without needing a DOM/component test harness (this
// codebase's established convention -- see reportStatus.test.ts).

const ALL_STATUSES: RunStatus[] = ["UPLOADED", "PROCESSING", "COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"];

test("isRunReportable: only COMPLETED and COMPLETED_WITH_ERRORS -- Generate Report / Download Excel must be hidden otherwise", () => {
  assert.equal(isRunReportable("COMPLETED"), true);
  assert.equal(isRunReportable("COMPLETED_WITH_ERRORS"), true);

  for (const status of ["UPLOADED", "PROCESSING", "CANCELLED"] as const) {
    assert.equal(isRunReportable(status), false, `expected ${status} to not be reportable`);
  }
});

test("isRunReportable: a CANCELLED run (terminal, but never completed) shows neither action -- this was the actual bug: Download Excel used to be gated by 'isTerminal' (which wrongly includes CANCELLED) instead of the app's existing reportable definition", () => {
  assert.equal(isRunReportable("CANCELLED"), false);
});

test("isRunCancelable: only UPLOADED and PROCESSING -- mirrors cancelRun's own backend guard exactly, unchanged by this fix", () => {
  assert.equal(isRunCancelable("UPLOADED"), true);
  assert.equal(isRunCancelable("PROCESSING"), true);
  for (const status of ["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"] as const) {
    assert.equal(isRunCancelable(status), false, `expected ${status} to not be cancelable`);
  }
});

test("isRunReportable / isRunCancelable never agree for a given RunStatus -- a run is never simultaneously reportable and actually cancelable, so cancelRun's own guard is never satisfiable from the reportable action area (Cancel Run renders there disabled, not gated by isRunCancelable)", () => {
  for (const status of ALL_STATUSES) {
    if (status === "CANCELLED") continue; // neither applies -- nothing to act on
    assert.notEqual(isRunReportable(status), isRunCancelable(status), `expected exactly one of reportable/cancelable for ${status}`);
  }
});

test("getExportUrl: Download Excel reuses the existing /runs/:id/export endpoint -- no new download route was introduced", () => {
  assert.equal(getExportUrl("run-123"), "/api/runs/run-123/export");
});
