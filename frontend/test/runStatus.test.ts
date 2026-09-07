import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunReportable } from "../src/components/run/runStatus.js";
import { getExportUrl } from "../src/api/client.js";

// FIX #3: the Run Detail action area's visibility rules, driven entirely by
// the backend-reported RunStatus (never progress %, row counts, or a
// timer). These pure functions are exactly what the Generate Report /
// Download Excel / Cancel buttons gate on, so testing them directly proves
// the visibility rule without needing a DOM/component test harness (this
// codebase's established convention -- see reportStatus.test.ts).

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

test("getExportUrl: Download Excel reuses the existing /runs/:id/export endpoint -- no new download route was introduced", () => {
  assert.equal(getExportUrl("run-123"), "/api/runs/run-123/export");
});
