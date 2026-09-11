import { prisma } from "../backend/db/client.js";
import { mapDataForSeoResponse } from "../backend/dataforseo/mapResponse.js";
import { recomputeRunCompletion } from "../backend/statemachine/runTransitions.js";

// One-off correction script -- NOT part of the normal worker/state-machine
// API. The two rows below were marked FAILED by a mapper bug (task status
// 40102 "No Search Results" was mis-treated as a permanent API error).
// No new DataForSEO call is made: we re-run the FIXED mapper against the
// raw_response already stored in ranking_row_attempts, and only mutate the
// row/attempt if the corrected outcome is SUCCESS -- this is a deliberate,
// explicit bypass of "FAILED is terminal" for this specific known-bad
// mapping bug, not a general retry mechanism.

const AFFECTED_KEYWORDS = ["car for cash removal", "cash for cars rockingham"];

const rows = await prisma.rankingRow.findMany({
  where: { keyword: { in: AFFECTED_KEYWORDS }, status: "FAILED" },
  include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
});

if (rows.length !== AFFECTED_KEYWORDS.length) {
  throw new Error(
    `Expected ${AFFECTED_KEYWORDS.length} FAILED rows for these keywords, found ${rows.length}. Stopping without changes.`,
  );
}

const runIds = new Set();

for (const row of rows) {
  const attempt = row.attempts[0];
  if (!attempt)
    throw new Error(
      `Row ${row.id} (${row.keyword}) has no attempt to re-map. Stopping.`,
    );

  const remapped = mapDataForSeoResponse({
    httpStatus: attempt.httpStatus,
    body: attempt.rawResponse,
    requestPayload: attempt.requestPayload,
  });

  console.log(
    `\n${row.keyword}: previous outcome=${attempt.outcome}, remapped outcome=${remapped.outcome}`,
  );

  if (remapped.outcome !== "SUCCESS") {
    console.log(
      "  Remapped outcome is not SUCCESS -- leaving this row untouched.",
    );
    continue;
  }

  await prisma.$transaction([
    prisma.rankingRowAttempt.update({
      where: { id: attempt.id },
      data: {
        outcome: "SUCCESS",
        mappedRankValue: remapped.rankValue,
        mappedRankingUrl: remapped.rankingUrl,
        errorMessage: null,
      },
    }),
    prisma.rankingRow.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        rankValue: remapped.rankValue,
        rankDisplay: remapped.rankDisplay,
        rankingUrl: remapped.rankingUrl,
        lastErrorMessage: null,
      },
    }),
  ]);

  console.log(
    `  Corrected: status=COMPLETED, rank_display=${JSON.stringify(remapped.rankDisplay)}`,
  );
  runIds.add(row.runId);
}

for (const runId of runIds) {
  const run = await prisma.rankingRun.findUniqueOrThrow({
    where: { id: runId },
  });
  const failedCount = await prisma.rankingRow.count({
    where: { runId, status: "FAILED" },
  });

  if (run.status === "PROCESSING") {
    const updated = await recomputeRunCompletion(runId);
    console.log(
      `\nRun ${runId}: recomputed -> ${updated?.status ?? "(still processing)"}`,
    );
    continue;
  }

  // Run had already been finalized (COMPLETED_WITH_ERRORS) before this
  // correction. If no FAILED rows remain, correct the run's terminal
  // status too -- same deliberate one-off exception as above.
  if (run.status === "COMPLETED_WITH_ERRORS" && failedCount === 0) {
    await prisma.rankingRun.update({
      where: { id: runId },
      data: { status: "COMPLETED" },
    });
    console.log(
      `\nRun ${runId}: corrected COMPLETED_WITH_ERRORS -> COMPLETED (no FAILED rows remain)`,
    );
  } else {
    console.log(
      `\nRun ${runId}: left as ${run.status} (${failedCount} FAILED row(s) remain)`,
    );
  }
}

const finalRows = await prisma.rankingRow.findMany({
  where: { keyword: { in: AFFECTED_KEYWORDS } },
  orderBy: { sourceRowNumber: "asc" },
});
console.log("\n--- Final state of the corrected rows ---");
console.table(
  finalRows.map((r) => ({
    keyword: r.keyword,
    status: r.status,
    rank_value: r.rankValue,
    rank_display: r.rankDisplay,
    ranking_url: r.rankingUrl,
  })),
);

await prisma.$disconnect();
