import { prisma } from "../db/client.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";

/**
 * Client view + portfolio (2026-11-23). A client's rank history is its BASELINES -- the verified ranks of every
 * report sent (or imported from the team's old reports), each dated -- plus its latest finished run when that is
 * newer and not yet a baseline ("latest check", not verified yet). Baselines carry only keyword + rank, so keywords
 * are matched by normalized keyword across points.
 */

const FINISHED = ["COMPLETED", "COMPLETED_WITH_ERRORS"] as const;
/** Runs shown on the client's trend chart and keyword table. */
const HISTORY_RUNS = 12;
/** A client whose last sent report is older than this is flagged "due" on the portfolio. */
export const REPORT_DUE_DAYS = 16;

export interface RankBuckets {
  total: number;
  top3: number;
  top10: number;
  top100: number;
}

type RowLite = { keyword: string; rankValue: number | null };

function buckets(rows: RowLite[]): RankBuckets {
  let top3 = 0;
  let top10 = 0;
  let top100 = 0;
  for (const r of rows) {
    if (r.rankValue === null || r.rankValue === undefined) continue;
    if (r.rankValue <= 3) top3++;
    if (r.rankValue <= 10) top10++;
    if (r.rankValue <= 100) top100++;
  }
  return { total: rows.length, top3, top10, top100 };
}

const keyOf = (r: { keyword: string }) => normalizeKeyword(r.keyword);

export interface HistoryPoint {
  /** "baseline" = verified ranks (a sent/imported report); "run" = the latest check, not verified yet. */
  kind: "baseline" | "run";
  id: string;
  date: Date;
  rows: RowLite[];
}

/** The client's last `take` history points, oldest first. */
export async function historyPoints(clientId: string, take: number): Promise<HistoryPoint[]> {
  const baselines = await prisma.rankingBaseline.findMany({
    where: { clientId },
    orderBy: [{ baselineDate: "desc" }, { createdAt: "desc" }],
    take: take * 2,
    select: { id: true, baselineDate: true, sourceRunId: true },
  });
  // One point per date (a re-import of the same date keeps the newest).
  const byDay = new Map<string, (typeof baselines)[number]>();
  for (const b of baselines) {
    const day = b.baselineDate.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, b);
  }
  const chosen = [...byDay.values()].slice(0, take);
  const points: HistoryPoint[] = [];
  for (const b of chosen) {
    const rows = await prisma.rankingBaselineRow.findMany({ where: { baselineId: b.id }, select: { keyword: true, rankValue: true } });
    if (rows.length) points.push({ kind: "baseline", id: b.id, date: b.baselineDate, rows });
  }
  const run = await prisma.rankingRun.findFirst({
    where: { clientId, status: { in: [...FINISHED] }, rows: { some: {} } },
    orderBy: { createdAt: "desc" },
  });
  const newest = points[0];
  const runIsBaseline = run ? chosen.some((b) => b.sourceRunId === run.id) : false;
  if (run && !runIsBaseline && (!newest || runDate(run).getTime() > newest.date.getTime())) {
    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id }, select: { keyword: true, rankValue: true } });
    points.unshift({ kind: "run", id: run.id, date: runDate(run), rows });
    if (points.length > take) points.pop();
  }
  return points.reverse();
}

/** Keywords that moved between two runs (lower rank number = better; "Not in 100" counts as 101). */
function movement(prev: RowLite[], latest: RowLite[]) {
  const before = new Map(prev.map((r) => [keyOf(r), r.rankValue]));
  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  for (const r of latest) {
    if (!before.has(keyOf(r))) continue;
    const a = before.get(keyOf(r)) ?? 101;
    const b = r.rankValue ?? 101;
    if (b < a) improved++;
    else if (b > a) declined++;
    else unchanged++;
  }
  return { improved, declined, unchanged };
}

function runDate(run: { completedAt: Date | null; startedAt: Date | null; createdAt: Date }) {
  return run.completedAt ?? run.startedAt ?? run.createdAt;
}

async function lastSentByClient(clientIds: string[]) {
  const sends = await prisma.reportSend.findMany({
    where: { report: { clientId: { in: clientIds } } },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true, manual: true, report: { select: { clientId: true, id: true } } },
  });
  const out = new Map<string, { sentAt: Date; reportId: string; manual: boolean }>();
  for (const s of sends) if (!out.has(s.report.clientId)) out.set(s.report.clientId, { sentAt: s.sentAt, reportId: s.report.id, manual: s.manual });
  return out;
}

export async function buildClientInsights(clientId: string, now = new Date()) {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { id: true, name: true, domain: true, isActive: true, archivedAt: true, consolidatedReport: true, reportTypeConfirmed: true, workspaceId: true, notes: true },
  });
  const points = await historyPoints(clientId, HISTORY_RUNS);
  const trend = points.map((p) => ({ kind: p.kind, id: p.id, date: p.date, ...buckets(p.rows) }));

  // Keyword table: every keyword of the latest point, with its rank at each point (null = not ranked / not tracked then).
  const latest = points.at(-1);
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  const lookups = points.map((p) => new Map(p.rows.map((r) => [keyOf(r), r.rankValue])));
  const seen = new Set<string>();
  const keywords = latest
    ? latest.rows
        .filter((row) => {
          const k = keyOf(row);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((row) => {
          const key = keyOf(row);
          const inPoint = lookups.map((m) => m.has(key));
          const ranks = lookups.map((m) => m.get(key) ?? null);
          const hadPrevious = prev ? inPoint[inPoint.length - 2] : false;
          return { keyword: row.keyword, ranks, inPoint, latest: row.rankValue, previous: hadPrevious ? ranks[ranks.length - 2] : null, hadPrevious };
        })
    : [];
  const moves = latest && prev ? movement(prev.rows, latest.rows) : null;

  const reports = await prisma.rankingReport.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, status: true, reportDate: true, createdAt: true, runId: true, attachmentSource: true, sends: { orderBy: { sentAt: "desc" }, take: 1, select: { sentAt: true, manual: true, sentBy: true } } },
  });
  const baselines = await prisma.rankingBaseline.findMany({
    where: { clientId },
    orderBy: { baselineDate: "desc" },
    take: 10,
    select: { id: true, baselineDate: true, createdAt: true, sourceFilename: true, sourceType: true, sourceRunId: true, _count: { select: { rows: true } } },
  });
  const openRun = await prisma.rankingRun.findFirst({
    where: { clientId, status: { in: ["UPLOADED", "QUEUED", "PROCESSING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true, totalRows: true },
  });
  const nextSlot = client.workspaceId
    ? await prisma.runSlot.findFirst({
        where: { workspaceId: client.workspaceId, startsAt: { gte: now }, OR: [{ clientIds: { isEmpty: true } }, { clientIds: { has: clientId } }] },
        orderBy: { startsAt: "asc" },
        select: { id: true, startsAt: true, durationMinutes: true },
      })
    : null;
  const lastSent = (await lastSentByClient([clientId])).get(clientId) ?? null;

  return {
    client: {
      ...client,
      reportType: client.consolidatedReport ? "consolidated" : client.reportTypeConfirmed ? "normal" : "unconfirmed",
    },
    trend,
    latest: latest ? { kind: latest.kind, id: latest.id, date: latest.date, ...buckets(latest.rows) } : null,
    previous: prev ? { kind: prev.kind, id: prev.id, date: prev.date, ...buckets(prev.rows) } : null,
    movement: moves,
    points: points.map((p) => ({ kind: p.kind, id: p.id, date: p.date })),
    keywords,
    reports: reports.map((r) => ({ id: r.id, status: r.status, reportDate: r.reportDate, createdAt: r.createdAt, runId: r.runId, attachment: r.attachmentSource, sentAt: r.sends[0]?.sentAt ?? null, sentManually: r.sends[0]?.manual ?? false, sentBy: r.sends[0]?.sentBy ?? null })),
    baselines: baselines.map((b) => ({ id: b.id, baselineDate: b.baselineDate, uploadedAt: b.createdAt, sourceFilename: b.sourceFilename, sourceType: b.sourceType, fromRun: !!b.sourceRunId, keywords: b._count.rows })),
    openRun,
    nextSlot,
    lastSent,
  };
}

/** Every active ranking client of a team on one screen. */
export async function buildPortfolio(workspaceId: string, now = new Date()) {
  const clients = await prisma.client.findMany({
    where: { workspaceId, kind: "ranking", archivedAt: null, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, domain: true, consolidatedReport: true, reportTypeConfirmed: true },
  });
  const ids = clients.map((c) => c.id);
  const lastSent = await lastSentByClient(ids);
  const slots = await prisma.runSlot.findMany({ where: { workspaceId, startsAt: { gte: now } }, orderBy: { startsAt: "asc" }, select: { startsAt: true, clientIds: true } });

  const out = [];
  for (const c of clients) {
    const points = await historyPoints(c.id, 2);
    const latest = points.at(-1) ?? null;
    const previous = points.length >= 2 ? points[0] : null;
    const lastRun = await prisma.rankingRun.findFirst({ where: { clientId: c.id, status: { in: [...FINISHED] } }, orderBy: { createdAt: "desc" } });
    const open = await prisma.rankingRun.findFirst({ where: { clientId: c.id, status: { in: ["QUEUED", "PROCESSING"] } }, select: { status: true } });
    const sent = lastSent.get(c.id) ?? null;
    const daysSinceSent = sent ? Math.floor((now.getTime() - sent.sentAt.getTime()) / 86_400_000) : null;
    const slot = slots.find((s) => s.clientIds.length === 0 || s.clientIds.includes(c.id)) ?? null;
    out.push({
      clientId: c.id,
      name: c.name,
      domain: c.domain,
      reportType: c.consolidatedReport ? "consolidated" : c.reportTypeConfirmed ? "normal" : "unconfirmed",
      lastRunAt: lastRun ? runDate(lastRun) : null,
      lastRunId: lastRun?.id ?? null,
      latestKind: latest?.kind ?? null,
      latestDate: latest?.date ?? null,
      latest: latest ? buckets(latest.rows) : null,
      previous: previous ? buckets(previous.rows) : null,
      movement: latest && previous ? movement(previous.rows, latest.rows) : null,
      runningNow: open?.status ?? null,
      lastSentAt: sent?.sentAt ?? null,
      daysSinceSent,
      reportDue: daysSinceSent === null ? true : daysSinceSent >= REPORT_DUE_DAYS,
      nextSlotAt: slot?.startsAt ?? null,
    });
  }
  return { clients: out, reportDueDays: REPORT_DUE_DAYS };
}
