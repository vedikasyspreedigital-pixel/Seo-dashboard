import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretCreateReportResponse } from "../src/api/client.js";

// Pure response interpreter for POST /api/reports, tested without mocking
// fetch -- mirrors backend/api/routes/reports.ts's exact status/body shapes
// for each outcome (see test/reportsApi.test.ts for the HTTP-layer half).

test("interpretCreateReportResponse: 201 -> CREATED with the report, at PENDING_ANALYSIS (no Claude call yet)", () => {
  const report = { id: "r1", status: "PENDING_ANALYSIS" };
  const result = interpretCreateReportResponse(201, { report });
  assert.deepEqual(result, { outcome: "CREATED", report });
});

test("interpretCreateReportResponse: 404 -> RUN_NOT_FOUND", () => {
  const result = interpretCreateReportResponse(404, { error: "Run not found" });
  assert.deepEqual(result, { outcome: "RUN_NOT_FOUND" });
});

test("interpretCreateReportResponse: 409 with existingReportId -> DUPLICATE", () => {
  const result = interpretCreateReportResponse(409, { error: "A report already exists for this run", existingReportId: "r1" });
  assert.deepEqual(result, { outcome: "DUPLICATE", existingReportId: "r1" });
});

test("interpretCreateReportResponse: 409 without existingReportId -> RUN_NOT_COMPLETED", () => {
  const result = interpretCreateReportResponse(409, { error: "Run is not completed (status: PROCESSING)" });
  assert.deepEqual(result, { outcome: "RUN_NOT_COMPLETED", message: "Run is not completed (status: PROCESSING)" });
});

test("interpretCreateReportResponse: any other status -> ERROR, falls back to a generic message", () => {
  const withMessage = interpretCreateReportResponse(500, { error: "boom" });
  assert.deepEqual(withMessage, { outcome: "ERROR", message: "boom" });

  const withoutMessage = interpretCreateReportResponse(500, {});
  assert.deepEqual(withoutMessage, { outcome: "ERROR", message: "Request failed with status 500" });
});
