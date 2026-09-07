import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeRouteForStatus } from "../src/components/report/reportFlowRoute.js";
import type { ReportStatus } from "../src/api/types.js";

// FIX #2: the single canonical "which page is this report for" resolver.
// Every wizard page and every entry point (Reports list, re-creating a
// report for a run that already has one) routes through this, so it must
// cover every ReportStatus exhaustively and never point a page at itself.

const ALL_STATUSES: ReportStatus[] = [
  "PENDING_ANALYSIS",
  "ANALYSIS_FAILED",
  "ANALYSIS_READY",
  "REPORT_READY",
  "EMAIL_DRAFT_FAILED",
  "EMAIL_DRAFTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "SENT",
];

test("resumeRouteForStatus: every ReportStatus resolves to exactly one wizard step", () => {
  const expected: Record<ReportStatus, string> = {
    PENDING_ANALYSIS: "/reports/r1/analytics",
    ANALYSIS_FAILED: "/reports/r1/analytics",
    ANALYSIS_READY: "/reports/r1/analytics",
    REPORT_READY: "/reports/r1/preview",
    EMAIL_DRAFT_FAILED: "/reports/r1/email",
    EMAIL_DRAFTED: "/reports/r1/email",
    PENDING_APPROVAL: "/reports/r1/email",
    APPROVED: "/reports/r1/send",
    REJECTED: "/reports/r1/send",
    SENT: "/reports/r1/send",
  };

  for (const status of ALL_STATUSES) {
    assert.equal(resumeRouteForStatus("r1", status), expected[status], `unexpected route for ${status}`);
  }
});

test("resumeRouteForStatus: interpolates the given reportId", () => {
  assert.equal(resumeRouteForStatus("abc-123", "REPORT_READY"), "/reports/abc-123/preview");
  assert.equal(resumeRouteForStatus("abc-123", "SENT"), "/reports/abc-123/send");
});
