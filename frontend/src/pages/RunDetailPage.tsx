import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { StatTile } from '../components/ui/StatTile';
import { StatusBadge } from '../components/run/StatusBadge';
import { ProcessingSummary } from '../components/run/ProcessingSummary';
import { CompletedSummary } from '../components/run/CompletedSummary';
import { useRunProgress } from '../hooks/useRunProgress';
import { useActiveClient } from '../context/ClientContext';
import { cancelRun, getExportUrl, getRun, getRunRows, startRun } from '../api/client';
import type { RankingRun, RunRow } from '../api/types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
const REPORTABLE_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS']);
const FILTERS = ['All', 'Completed', 'Error-Retry', 'Failed'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_TO_ROW_STATUS: Record<Filter, string | null> = {
  All: null,
  Completed: 'COMPLETED',
  'Error-Retry': 'ERROR_RETRY',
  Failed: 'FAILED',
};

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();
  const { progress } = useRunProgress(runId ?? null);

  const [run, setRun] = useState<RankingRun | null>(null);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<Filter>('All');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    getRun(runId).then(setRun);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getRunRows(runId).then((data) => {
      if (!cancelled) setRows(data);
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch rows every time progress changes (each poll tick), so the
    // table reflects live rank/status updates while a run is processing.
  }, [runId, progress]);

  if (!runId) return null;

  const status = progress?.runStatus ?? run?.status;
  const isTerminal = status ? TERMINAL_STATUSES.has(status) : false;
  const isReportable = status ? REPORTABLE_STATUSES.has(status) : false;

  async function handleStart() {
    if (!runId) return;
    setConfirmingStart(false);
    setStarting(true);
    setActionError(null);
    try {
      const updated = await startRun(runId);
      setRun(updated);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!runId) return;
    setCancelling(true);
    setActionError(null);
    try {
      const updated = await cancelRun(runId);
      setRun(updated);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  const filteredRows = rows.filter((row) => {
    const target = FILTER_TO_ROW_STATUS[filter];
    return target === null || row.status === target;
  });

  const totals = computeTotals(rows);

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: 'Runs', to: '/runs' }, { label: run ? `#${run.id.slice(0, 8)}` : '...' }]}
        action={
          (run?.status === 'UPLOADED' || run?.status === 'PROCESSING') && !confirmingStart ? (
            <div className="flex items-center gap-3">
              <Button variant="ghost" disabled={cancelling} onClick={handleCancel}>
                {cancelling && <Spinner />}
                Cancel Run
              </Button>
              {run.status === 'UPLOADED' && <Button onClick={() => setConfirmingStart(true)}>Start Run</Button>}
            </div>
          ) : (
            isTerminal && (
              <div className="flex items-center gap-3">
                <a href={getExportUrl(runId)}>
                  <Button variant="secondary">Download Excel</Button>
                </a>
                {isReportable && <Button onClick={() => navigate(`/runs/${runId}/report/new`)}>Generate Report</Button>}
              </div>
            )
          )
        }
      />

      {confirmingStart && run && (
        <div className="mt-3 flex items-center justify-end gap-3 text-sm">
          <span className="font-medium text-amber-300">
            Process {run.totalRows} row{run.totalRows === 1 ? '' : 's'} &mdash; confirm?
          </span>
          <Button disabled={starting} onClick={handleStart}>
            {starting && <Spinner />}
            Confirm
          </Button>
          <Button variant="ghost" disabled={starting} onClick={() => setConfirmingStart(false)}>
            Cancel
          </Button>
        </div>
      )}

      {actionError && <p className="mt-2 text-sm font-medium text-rose-300">{actionError}</p>}

      {progress && !isTerminal && (
        <div className="mt-6">
          <ProcessingSummary progress={progress} />
        </div>
      )}

      {isTerminal && run && (
        <div className="mt-6">
          <CompletedSummary status={run.status} totalRows={totals.total} failedCount={totals.failed} completedAt={run.completedAt} />
        </div>
      )}

      {!isTerminal && (
        <Card className="mt-6 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-[var(--color-ink)]">{run?.sourceFilename ?? 'Loading...'}</p>
              <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                {run && `Created ${new Date(run.createdAt).toLocaleString()} · ${activeClient?.name ?? ''}`}
              </p>
            </div>
            <div className="flex items-center gap-5">
              {run && (
                <div className="text-right">
                  <p className="font-mono text-3xl font-bold leading-none text-[var(--color-ink)]">{run.totalRows}</p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Rows</p>
                </div>
              )}
              {status && <StatusBadge status={status} />}
            </div>
          </div>
        </Card>
      )}

      {isTerminal && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Total" value={totals.total} />
          <StatTile label="Top 3" value={totals.top3} accent="text-brand-300" />
          <StatTile label="Top 10" value={totals.top10} accent="text-blue-300" />
          <StatTile label="Avg Rank" value={totals.avgRank ?? '—'} />
          <StatTile label="Not in 100" value={totals.notIn100} accent="text-rose-300" />
        </div>
      )}

      <Card className="mt-4 overflow-hidden p-0">
        {isTerminal && (
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-6 py-4">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Filter</span>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  filter === f
                    ? 'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3),0_0_35px_rgba(139,92,246,0.12)]'
                    : 'text-[var(--color-ink-muted)] hover:bg-white/[0.04]'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">
              <th className="px-6 py-3.5">Keyword</th>
              <th className="px-6 py-3.5">Location</th>
              <th className="px-6 py-3.5">Lang</th>
              <th className="px-6 py-3.5">Status</th>
              <th className="px-6 py-3.5">Rank</th>
              <th className="px-6 py-3.5">Ranking URL</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                <td className="px-6 py-3.5 text-[var(--color-ink)]">{row.keyword}</td>
                <td className="px-6 py-3.5 text-[var(--color-ink-muted)]">{row.locationName}</td>
                <td className="px-6 py-3.5 text-[var(--color-ink-muted)]">{row.languageName}</td>
                <td className="px-6 py-3.5">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-6 py-3.5 font-mono text-[var(--color-ink)]">{formatRank(row.rankDisplay)}</td>
                <td className="max-w-xs truncate px-6 py-3.5">
                  {row.rankingUrl ? (
                    <a href={row.rankingUrl} target="_blank" rel="noreferrer" className="text-brand-300 hover:text-brand-200">
                      {row.rankingUrl}
                    </a>
                  ) : (
                    <span className="text-[var(--color-ink-faint)]">&mdash;</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
        <Link to="/runs" className="hover:text-[var(--color-ink-muted)]">
          &larr; Back to Runs
        </Link>
      </p>
    </AppShell>
  );
}

function formatRank(rankDisplay: string | null): string {
  if (!rankDisplay) return '—';
  return Number.isNaN(Number(rankDisplay)) ? rankDisplay : `#${rankDisplay}`;
}

function computeTotals(rows: RunRow[]) {
  const ranked = rows.filter((r) => r.rankDisplay !== null && !Number.isNaN(Number(r.rankDisplay)));
  const ranks = ranked.map((r) => Number(r.rankDisplay));
  const avgRank = ranks.length > 0 ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10 : null;
  return {
    total: rows.length,
    top3: ranks.filter((r) => r <= 3).length,
    top10: ranks.filter((r) => r <= 10).length,
    avgRank,
    notIn100: rows.length - ranked.length,
    failed: rows.filter((r) => r.status === 'FAILED').length,
  };
}
