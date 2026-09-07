import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { StatTile } from '../components/ui/StatTile';
import { InlineError } from '../components/ui/InlineError';
import { FilterPills } from '../components/ui/FilterPills';
import { StatusBadge } from '../components/run/StatusBadge';
import { ProcessingSummary } from '../components/run/ProcessingSummary';
import { CompletedSummary } from '../components/run/CompletedSummary';
import { useRunProgress } from '../hooks/useRunProgress';
import { useActiveClient } from '../context/ClientContext';
import { isRunReportable } from '../components/run/runStatus';
import { cancelRun, getExportUrl, getRun, getRunRows, startRun } from '../api/client';
import type { RankingRun, RunRow } from '../api/types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
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
  const isReportable = status ? isRunReportable(status) : false;

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
          run?.status === 'UPLOADED' || run?.status === 'PROCESSING' ? (
            // Cancel Run stays mounted here regardless of confirmingStart
            // (just disabled while confirming, same as it being absent
            // before -- neither is clickable) so this action slot never
            // collapses to empty when "Start Run" is clicked. That collapse
            // was the other source of the page-load-position jump: with
            // nothing here, the header row shrinks to the breadcrumb's
            // height alone and everything below shifts up.
            <div className="flex items-center gap-3">
              <Button variant="ghost" disabled={cancelling || confirmingStart} onClick={handleCancel}>
                {cancelling && <Spinner />}
                Cancel Run
              </Button>
              {run.status === 'UPLOADED' && !confirmingStart && <Button onClick={() => setConfirmingStart(true)}>Start Run</Button>}
            </div>
          ) : (
            // Generate Report and Download Excel only appear once the run
            // is genuinely reportable (COMPLETED | COMPLETED_WITH_ERRORS) --
            // the same existing definition already used elsewhere in this
            // app, not the broader "isTerminal" (which also includes
            // CANCELLED, a run that was never completed and has nothing to
            // report or download). Cancel stays in the same action area,
            // disabled -- it's the same button/API as above, just inert
            // here since cancelRun only ever accepts UPLOADED/PROCESSING.
            isReportable && (
              <div className="flex items-center gap-3">
                <Button onClick={() => navigate(`/runs/${runId}/report/new`)}>Generate Report</Button>
                <a href={getExportUrl(runId)}>
                  <Button variant="secondary">Download Excel</Button>
                </a>
                <Button variant="ghost" disabled title="This run has already finished -- nothing to cancel">
                  Cancel Run
                </Button>
              </div>
            )
          )
        }
      />

      {/*
        Always mounted (not just while confirmingStart is true) so this row's
        space is reserved from the moment a Start-Run-eligible run loads --
        toggling confirmingStart only flips visibility, never
        mounts/unmounts the element, so the page never jumps when "Start
        Run" is clicked. Only rendered at all while the run is UPLOADED,
        since that's the only status this control is ever relevant for.
      */}
      {run?.status === 'UPLOADED' && (
        <div
          className={`mt-3 flex items-center justify-end gap-3 text-sm ${confirmingStart ? '' : 'invisible'}`}
          aria-hidden={!confirmingStart}
        >
          <span className="font-medium text-amber-300">
            Process {run.totalRows} row{run.totalRows === 1 ? '' : 's'} &mdash; confirm?
          </span>
          <Button disabled={!confirmingStart || starting} onClick={handleStart}>
            {starting && <Spinner />}
            Confirm
          </Button>
          <Button variant="ghost" disabled={!confirmingStart || starting} onClick={() => setConfirmingStart(false)}>
            Cancel
          </Button>
        </div>
      )}

      <InlineError message={actionError} className="mt-2" />

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
            <span className="eyebrow-label">Filter</span>
            <FilterPills options={FILTERS} value={filter} onChange={setFilter} />
          </div>
        )}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] eyebrow-label">
              <th className="cell-compact">Keyword</th>
              <th className="cell-compact">Location</th>
              <th className="cell-compact">Lang</th>
              <th className="cell-compact">Status</th>
              <th className="cell-compact">Rank</th>
              <th className="cell-compact">Ranking URL</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                <td className="cell-compact text-[var(--color-ink)]">{row.keyword}</td>
                <td className="cell-compact text-[var(--color-ink-muted)]">{row.locationName}</td>
                <td className="cell-compact text-[var(--color-ink-muted)]">{row.languageName}</td>
                <td className="cell-compact">
                  <StatusBadge status={row.status} />
                </td>
                <td className="cell-compact font-mono text-[var(--color-ink)]">{formatRank(row.rankDisplay)}</td>
                <td className="max-w-xs truncate cell-compact">
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
