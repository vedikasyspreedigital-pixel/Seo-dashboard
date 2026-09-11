import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunCompletionNotification } from "../src/components/run/runCompletionNotification.js";

test("resolveRunCompletionNotification: fires on the edge from a non-terminal into each terminal status", () => {
  assert.deepEqual(resolveRunCompletionNotification("PROCESSING", "COMPLETED", "keywords.xlsx"), {
    message: "Run completed: keywords.xlsx",
    tone: "success",
  });
  assert.deepEqual(resolveRunCompletionNotification("PROCESSING", "COMPLETED_WITH_ERRORS", "keywords.xlsx"), {
    message: "Run completed with errors: keywords.xlsx",
    tone: "warning",
  });
  assert.deepEqual(resolveRunCompletionNotification("PROCESSING", "CANCELLED", "keywords.xlsx"), {
    message: "Run cancelled: keywords.xlsx",
    tone: "neutral",
  });
});

test("resolveRunCompletionNotification: never fires on the first poll (previousStatus null) -- a run already finished before the page opened must not toast", () => {
  assert.equal(resolveRunCompletionNotification(null, "COMPLETED", "keywords.xlsx"), null);
  assert.equal(resolveRunCompletionNotification(null, "PROCESSING", "keywords.xlsx"), null);
});

test("resolveRunCompletionNotification: never fires again once already terminal -- guards against StrictMode double-invoke or a stray extra poll re-triggering the same toast", () => {
  assert.equal(resolveRunCompletionNotification("COMPLETED", "COMPLETED", "keywords.xlsx"), null);
  assert.equal(resolveRunCompletionNotification("CANCELLED", "CANCELLED", "keywords.xlsx"), null);
});

test("resolveRunCompletionNotification: no notification while still in-flight between two non-terminal statuses", () => {
  assert.equal(resolveRunCompletionNotification("UPLOADED", "PROCESSING", "keywords.xlsx"), null);
});
