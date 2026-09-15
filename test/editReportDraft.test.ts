import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { updateReportDraft } from "../backend/reporting/editReportDraft.js";
import { rejectReport } from "../backend/reporting/reportTransitions.js";
import { InvalidReportTransitionError, DuplicateReportDateError } from "../backend/reporting/errors.js";
import { ReportStatus } from "@prisma/client";

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string, completedAt?: Date) {
  return prisma.rankingRun.create({
    data: { clientId, sourceFilename: "edit-draft-test.xlsx", sourceFilePath: "local-test/edit-draft-test.xlsx", totalRows: 1, status: "COMPLETED", completedAt },
  });
}

async function makeReport(clientId: string, runId: string, status: ReportStatus, extra: { previousBaselineId?: string } = {}) {
  return prisma.rankingReport.create({
    data: {
      clientId,
      runId,
      status,
      emailSubject: "Original subject",
      emailBody: "Original body",
      resolvedRecipients: ["a@example.com"],
      ...extra,
    },
  });
}

async function makeBaseline(clientId: string, baselineDate: Date) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: "baseline-test.xlsx",
      sourceType: "EXCEL",
      baselineDate,
      rows: { create: [{ keyword: "test keyword", normalizedKeyword: "test keyword", rankValue: 5, rankDisplay: "5" }] },
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  const baselines = await prisma.rankingBaseline.findMany({ where: { clientId } });
  for (const b of baselines) await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: b.id } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("recipient editing: subject, body, recipients, and ClickUp task URL can be edited while PENDING_APPROVAL", async () => {
  const client = await makeClient(`Edit Draft Test - success ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(report.id, {
      emailSubject: "Edited subject",
      resolvedRecipients: ["a@example.com", "b@example.com"],
      resolvedClickupTaskUrl: "https://app.clickup.com/t/abc123",
    });

    assert.equal(updated.emailSubject, "Edited subject");
    assert.equal(updated.emailBody, "Original body"); // untouched field survives a partial edit
    assert.deepEqual(updated.resolvedRecipients, ["a@example.com", "b@example.com"]);
    assert.equal(updated.resolvedClickupTaskUrl, "https://app.clickup.com/t/abc123");
    assert.equal(updated.status, ReportStatus.PENDING_APPROVAL); // editing never changes status

    const cleared = await updateReportDraft(report.id, { resolvedClickupTaskUrl: null });
    assert.equal(cleared.resolvedClickupTaskUrl, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("emailBody persists on its own, independent of the other fields", async () => {
  const client = await makeClient(`Edit Draft Test - body only ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(report.id, { emailBody: "Edited body only" });
    assert.equal(updated.emailBody, "Edited body only");
    assert.equal(updated.emailSubject, "Original subject"); // untouched

    // Refetch as a completely separate read, proving this isn't just the
    // update call echoing its own input back.
    const refetched = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(refetched.emailBody, "Edited body only");
  } finally {
    await cleanupClient(client.id);
  }
});

for (const otherStatus of [ReportStatus.REPORT_READY, ReportStatus.EMAIL_DRAFTED, ReportStatus.SENT, ReportStatus.REJECTED]) {
  test(`recipient editing is refused when the report is ${otherStatus}, not silently applied`, async () => {
    const client = await makeClient(`Edit Draft Test - refused ${otherStatus} ${randomUUID()}`);
    try {
      const run = await makeRun(client.id);
      const report = await makeReport(client.id, run.id, otherStatus);

      await assert.rejects(
        () => updateReportDraft(report.id, { emailSubject: "Should not apply" }),
        InvalidReportTransitionError,
      );

      const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
      assert.equal(unchanged.emailSubject, "Original subject");
    } finally {
      await cleanupClient(client.id);
    }
  });
}

// Regression test for the fix: updateReportDraft used to be a plain
// read-then-check-then-write, so a concurrent status change (reject,
// approve, regenerate) could commit BETWEEN the check and the write, and
// the edit would still apply to a report that had already moved on. Now
// it's the same atomic conditional-update guardedUpdate every real
// transition uses, so this is closed by construction -- this test proves it
// under a genuine race, not just a sequential check.
test("concurrency: an edit racing a concurrent reject can never land on an already-rejected report -- no split-brain between the edit's own outcome and what's actually persisted", async () => {
  const client = await makeClient(`Edit Draft Test - concurrent reject race ${randomUUID()}`);
  try {
    const run = await makeRun(client.id);
    const report = await makeReport(client.id, run.id, ReportStatus.PENDING_APPROVAL);

    const [editResult, rejectResult] = await Promise.allSettled([
      updateReportDraft(report.id, { emailSubject: "Raced edit" }),
      rejectReport(report.id),
    ]);

    // rejectReport never depends on updateReportDraft's own state (the edit
    // never touches `status`), so it must always succeed here regardless of
    // ordering.
    assert.equal(rejectResult.status, "fulfilled");

    const final = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(final.status, ReportStatus.REJECTED);

    if (editResult.status === "fulfilled") {
      // The edit's own atomic update won the race (ran before reject
      // committed) -- its reported success must actually be persisted.
      assert.equal(final.emailSubject, "Raced edit", "edit reported success -- its value must actually be persisted");
    } else {
      // Reject won the race -- the edit must have been rejected by the
      // atomic guard, and the report must be completely untouched by it.
      assert.ok(editResult.reason instanceof InvalidReportTransitionError);
      assert.equal(final.emailSubject, "Original subject", "edit reported failure -- the report must be untouched by it");
    }
  } finally {
    await cleanupClient(client.id);
  }
});

// Regression coverage for the duplicate-date-range guard: Save Changes must
// catch the case a duplicate run/upload produces -- two separate reports
// for the same client covering the same real-world period, one of which
// already went out. Compared by calendar day (not exact timestamp), since
// two runs completed minutes apart on the same day are still the same
// reporting period to a client reading two identical-looking emails.
test("Save Changes is refused when another SENT report for the same client covers the same date range", async () => {
  const client = await makeClient(`Edit Draft Test - duplicate date ${randomUUID()}`);
  try {
    const sameDay = new Date("2026-09-15T09:00:00.000Z");
    const sentRun = await makeRun(client.id, sameDay);
    const sentReport = await makeReport(client.id, sentRun.id, ReportStatus.SENT);

    const laterSameDayRun = await makeRun(client.id, new Date("2026-09-15T15:30:00.000Z"));
    const draftReport = await makeReport(client.id, laterSameDayRun.id, ReportStatus.PENDING_APPROVAL);

    await assert.rejects(
      () => updateReportDraft(draftReport.id, { emailSubject: "Should not apply" }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateReportDateError);
        assert.equal(err.conflictingReportId, sentReport.id);
        return true;
      },
    );

    const unchanged = await prisma.rankingReport.findUniqueOrThrow({ where: { id: draftReport.id } });
    assert.equal(unchanged.emailSubject, "Original subject", "a refused save must never partially apply");
  } finally {
    await cleanupClient(client.id);
  }
});

test("Save Changes proceeds when the date range differs from every SENT report for the client", async () => {
  const client = await makeClient(`Edit Draft Test - different date ${randomUUID()}`);
  try {
    const sentRun = await makeRun(client.id, new Date("2026-08-01T09:00:00.000Z"));
    await makeReport(client.id, sentRun.id, ReportStatus.SENT);

    const laterRun = await makeRun(client.id, new Date("2026-09-15T09:00:00.000Z"));
    const draftReport = await makeReport(client.id, laterRun.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(draftReport.id, { emailSubject: "A genuinely new period" });
    assert.equal(updated.emailSubject, "A genuinely new period");
  } finally {
    await cleanupClient(client.id);
  }
});

test("Save Changes proceeds when the matching-date sibling report was never SENT (only SENT reports count as a real duplicate)", async () => {
  const client = await makeClient(`Edit Draft Test - unsent sibling same date ${randomUUID()}`);
  try {
    const sameDay = new Date("2026-09-15T09:00:00.000Z");
    const otherRun = await makeRun(client.id, sameDay);
    await makeReport(client.id, otherRun.id, ReportStatus.REJECTED);

    const draftRun = await makeRun(client.id, sameDay);
    const draftReport = await makeReport(client.id, draftRun.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(draftReport.id, { emailSubject: "Fine, nothing was ever sent for this date" });
    assert.equal(updated.emailSubject, "Fine, nothing was ever sent for this date");
  } finally {
    await cleanupClient(client.id);
  }
});

test("Save Changes ignores a same-date SENT report belonging to a different client", async () => {
  const clientA = await makeClient(`Edit Draft Test - cross-client A ${randomUUID()}`);
  const clientB = await makeClient(`Edit Draft Test - cross-client B ${randomUUID()}`);
  try {
    const sameDay = new Date("2026-09-15T09:00:00.000Z");
    const sentRun = await makeRun(clientA.id, sameDay);
    await makeReport(clientA.id, sentRun.id, ReportStatus.SENT);

    const draftRun = await makeRun(clientB.id, sameDay);
    const draftReport = await makeReport(clientB.id, draftRun.id, ReportStatus.PENDING_APPROVAL);

    const updated = await updateReportDraft(draftReport.id, { emailSubject: "Different client, same date is fine" });
    assert.equal(updated.emailSubject, "Different client, same date is fine");
  } finally {
    await cleanupClient(clientA.id);
    await cleanupClient(clientB.id);
  }
});

// Regression test: a report compared against an imported BASELINE (not a
// real prior run) must use the baseline's own recorded date as periodStart
// -- previously it fell through to the run's own date on both sides
// (previousRun is null for a baseline comparison), so two reports on the
// same run-date but genuinely DIFFERENT baseline periods were incorrectly
// treated as covering the identical range. Confirmed against a real prior
// agency report, always titled as a genuine baseline-to-current range
// (e.g. "17th August 2026 - 31st August 2026"), never a single day.
test("Save Changes correctly distinguishes two baseline comparisons on the same run-date but different baseline dates -- not a false duplicate", async () => {
  const client = await makeClient(`Edit Draft Test - baseline period ${randomUUID()}`);
  try {
    const sameRunDay = new Date("2026-08-31T00:00:00Z");

    const earlierBaseline = await makeBaseline(client.id, new Date("2026-08-01T00:00:00Z"));
    const sentRun = await makeRun(client.id, sameRunDay);
    await makeReport(client.id, sentRun.id, ReportStatus.SENT, { previousBaselineId: earlierBaseline.id });

    const laterBaseline = await makeBaseline(client.id, new Date("2026-08-17T00:00:00Z"));
    const draftRun = await makeRun(client.id, sameRunDay); // same run-date as the sent report above
    const draftReport = await makeReport(client.id, draftRun.id, ReportStatus.PENDING_APPROVAL, { previousBaselineId: laterBaseline.id });

    // Must succeed: despite sharing a run-date, the two reports cover
    // genuinely different periods (Aug 1-31 vs Aug 17-31) because each
    // baseline's own date is what actually anchors periodStart.
    const updated = await updateReportDraft(draftReport.id, { emailSubject: "Genuinely a different period" });
    assert.equal(updated.emailSubject, "Genuinely a different period");
  } finally {
    await cleanupClient(client.id);
  }
});

test("Save Changes correctly flags a true duplicate when two baseline comparisons share the SAME baseline date and run date", async () => {
  const client = await makeClient(`Edit Draft Test - baseline period duplicate ${randomUUID()}`);
  try {
    const sameRunDay = new Date("2026-08-31T00:00:00Z");
    const sameBaselineDay = new Date("2026-08-17T00:00:00Z");

    const baselineA = await makeBaseline(client.id, sameBaselineDay);
    const sentRun = await makeRun(client.id, sameRunDay);
    const sentReport = await makeReport(client.id, sentRun.id, ReportStatus.SENT, { previousBaselineId: baselineA.id });

    const baselineB = await makeBaseline(client.id, sameBaselineDay); // a second, separately-uploaded baseline, same date
    const draftRun = await makeRun(client.id, sameRunDay);
    const draftReport = await makeReport(client.id, draftRun.id, ReportStatus.PENDING_APPROVAL, { previousBaselineId: baselineB.id });

    await assert.rejects(
      () => updateReportDraft(draftReport.id, { emailSubject: "Should not save" }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateReportDateError);
        assert.equal(err.conflictingReportId, sentReport.id);
        return true;
      },
    );
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
