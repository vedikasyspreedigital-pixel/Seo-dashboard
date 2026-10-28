import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleSelectionProblem } from "../src/utils/bundleSelection.js";

// Domain Intelligence: the team ticks which of the 5 reports to make (2026-10-27).

test("bundleSelectionProblem: any set works, except none, or the AI audit without BOTH audits it's written from", () => {
  assert.equal(bundleSelectionProblem(["keywords", "gap", "siteaudit", "woorank", "aiaudit"]), null);
  assert.equal(bundleSelectionProblem(["keywords"]), null);
  assert.equal(bundleSelectionProblem(["gap"]), null);
  assert.equal(bundleSelectionProblem(["siteaudit", "woorank", "aiaudit"]), null);
  assert.match(bundleSelectionProblem([]) ?? "", /at least one/);
  assert.match(bundleSelectionProblem(["aiaudit"]) ?? "", /tick both/);
  assert.match(bundleSelectionProblem(["aiaudit", "siteaudit"]) ?? "", /tick both/);
  assert.match(bundleSelectionProblem(["keywords", "woorank", "aiaudit"]) ?? "", /tick both/);
});
