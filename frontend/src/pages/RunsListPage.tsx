import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EyeIcon, RefreshIcon, TrashIcon } from '../components/ui/icons';
import { StatusBadge } from '../components/run/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { useActiveClient } from '../context/ClientContext';
import { deleteRun, getRuns } from '../api/client';
import { formatDate, formatDateTime } from '../utils/formatters';
import type { RankingRun } from '../api/types';

function shortId(id: string) {
  return `#${id.slice(0, 8)}`;
}

export function RunsListPage() {
  const { activeClient } = useActiveClient();
  const [runs, setRuns] = useState<RankingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeClient) {
      setRuns([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getRuns(activeClient.id)
      .then((data) => {
        if (!cancelled) setRuns(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeClient]);

  async function handleDelete(run: RankingRun) {
    if (
      !window.confirm(
        `Delete run ${shortId(run.id)}? This also deletes any report generated from this run (including its PDF, and even if it was already sent to the client) and cannot be undone.`,
      )
    )
      return;
    setDeletingRunId(run.id);
    setActionError(null);
    try {
      await deleteRun(run.id);
      setRuns((currentRuns) => currentRuns.filter((currentRun) => currentRun.id !== run.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to delete this run.');
    } finally {
      setDeletingRunId(null);
    }
  }

  const lastRun = runs[0];

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: activeClient?.name ?? '...' }, { label: 'Runs' }]}
        action={
          <Link to="/runs/new">
            <Button>+ New Run</Button>
          </Link>
        }
      />

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <PageTitle
          title="Ranking Runs"
          subtitle={activeClient ? `${activeClient.name} · ${runs.length} run${runs.length === 1 ? '' : 's'} total` : undefined}
        />
        {lastRun && (
          <div className="text-right">
            <p className="eyebrow-label">Last run</p>
            <p className="mt-1 font-mono text-sm text-[var(--color-ink)]">{formatDate(lastRun.createdAt)}</p>
          </div>
        )}
      </div>

      <Card className="mt-6 overflow-hidden p-0">
        {actionError && <p className="border-b border-rose-500/20 bg-rose-500/10 px-6 py-3 text-sm text-rose-200">{actionError}</p>}
        {loading ? (
          <EmptyState label="Loading..." />
        ) : runs.length === 0 ? (
          <EmptyState label="No runs yet for this client." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] eyebrow-label">
                <th className="cell-compact">Run ID</th>
                <th className="cell-compact">Created</th>
                <th className="cell-compact">File</th>
                <th className="cell-compact">Rows</th>
                <th className="cell-compact">Status</th>
                <th className="cell-compact" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="cell-cozy font-mono text-blue-300">{shortId(run.id)}</td>
                  <td className="cell-cozy text-[var(--color-ink-muted)]">{formatDateTime(run.createdAt)}</td>
                  <td className="cell-cozy text-[var(--color-ink)]">{run.sourceFilename}</td>
                  <td className="cell-cozy font-mono text-[var(--color-ink)]">{run.totalRows}</td>
                  <td className="cell-cozy">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="cell-cozy text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        to={`/runs/${run.id}`}
                        title="View"
                        aria-label={`View run ${shortId(run.id)}`}
                        className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]"
                      >
                        <EyeIcon className="h-4 w-4" />
                      </Link>
                      <button
                        type="button"
                        title="Rerun (coming soon)"
                        disabled
                        aria-label={`Rerun ${shortId(run.id)} (coming soon)`}
                        className="cursor-not-allowed rounded-full p-1.5 text-[var(--color-ink-muted)] opacity-40"
                      >
                        <RefreshIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        disabled={deletingRunId !== null}
                        onClick={() => handleDelete(run)}
                        aria-label={`Delete run ${shortId(run.id)}`}
                        className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50"
                      >
                        {deletingRunId === run.id ? <Spinner className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </AppShell>
  );
}
