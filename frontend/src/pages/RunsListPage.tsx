import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/run/StatusBadge';
import { useActiveClient } from '../context/ClientContext';
import { getRuns } from '../api/client';
import type { RankingRun } from '../api/types';

function shortId(id: string) {
  return `#${id.slice(0, 8)}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RunsListPage() {
  const { activeClient } = useActiveClient();
  const [runs, setRuns] = useState<RankingRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeClient) return;
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
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Last run</p>
            <p className="mt-1 font-mono text-sm text-[var(--color-ink)]">{formatDate(lastRun.createdAt)}</p>
          </div>
        )}
      </div>

      <Card className="mt-6 overflow-hidden p-0">
        {loading ? (
          <p className="p-6 text-sm text-[var(--color-ink-muted)]">Loading...</p>
        ) : runs.length === 0 ? (
          <p className="p-6 text-sm text-[var(--color-ink-muted)]">No runs yet for this client.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">
                <th className="px-6 py-3.5">Run ID</th>
                <th className="px-6 py-3.5">Created</th>
                <th className="px-6 py-3.5">File</th>
                <th className="px-6 py-3.5">Rows</th>
                <th className="px-6 py-3.5">Status</th>
                <th className="px-6 py-3.5" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="px-6 py-4 font-mono text-blue-300">{shortId(run.id)}</td>
                  <td className="px-6 py-4 text-[var(--color-ink-muted)]">{formatDateTime(run.createdAt)}</td>
                  <td className="px-6 py-4 text-[var(--color-ink)]">{run.sourceFilename}</td>
                  <td className="px-6 py-4 font-mono text-[var(--color-ink)]">{run.totalRows}</td>
                  <td className="px-6 py-4">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-6 py-4 text-right">
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
