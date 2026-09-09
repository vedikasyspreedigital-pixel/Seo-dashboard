import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/run/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { useActiveClient } from '../context/ClientContext';
import { getRuns } from '../api/client';
import { formatDate, formatDateTime } from '../utils/formatters';
import type { RankingRun } from '../api/types';

function shortId(id: string) {
  return `#${id.slice(0, 8)}`;
}

export function RunsListPage() {
  const { activeClient } = useActiveClient();
  const [runs, setRuns] = useState<RankingRun[]>([]);
  const [loading, setLoading] = useState(true);

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
                    <Link to={`/runs/${run.id}`} className="font-semibold text-brand-300 hover:text-brand-200">
                      View &rarr;
                    </Link>
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
