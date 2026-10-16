import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ReportStatusBadge } from '../components/report/ReportStatusBadge';
import { EmptyState, LoadingRows } from '../components/ui/EmptyState';
import { useActiveClient } from '../context/ClientContext';
import { useClientScopedList } from '../hooks/useClientScopedList';
import { getReports } from '../api/client';
import { resumeRouteForStatus } from '../components/report/reportFlowRoute';
import { formatDateTime } from '../utils/formatters';
import type { RankingReportListItem } from '../api/types';

export function ReportsListPage() {
  const { activeClient } = useActiveClient();
  const { items: reports, loading, error, reload } = useClientScopedList<RankingReportListItem>(activeClient?.id ?? null, getReports);

  return (
    <AppShell>
      <PageHeader breadcrumbs={[{ label: activeClient?.name ?? '...' }, { label: 'Reports' }]} />
      <PageTitle title="Client Reports" subtitle={activeClient ? `${activeClient.name} · ${reports.length} report${reports.length === 1 ? '' : 's'}` : undefined} />

      <Card className="mt-6 overflow-hidden p-0">
        {!activeClient ? (
          <EmptyState label="Select a client in the top bar to see its reports." />
        ) : error && reports.length === 0 ? (
          <EmptyState
            tone="error"
            label="Couldn't load reports."
            hint={`${error} -- your reports are safe; this is a loading problem, not lost data.`}
            action={<Button variant="secondary" onClick={reload}>Retry</Button>}
          />
        ) : loading && reports.length === 0 ? (
          <LoadingRows label="Loading reports" />
        ) : reports.length === 0 ? (
          <EmptyState label="No reports yet. Generate one from a completed run's detail page." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] eyebrow-label">
                <th className="cell-compact">Report</th>
                <th className="cell-compact">From run</th>
                <th className="cell-compact">Created</th>
                <th className="cell-compact">Status</th>
                <th className="cell-compact" />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="cell-cozy font-mono text-blue-300">#{report.id.slice(0, 8)}</td>
                  <td className="cell-cozy text-[var(--color-ink)]">{report.run.sourceFilename}</td>
                  <td className="cell-cozy text-[var(--color-ink-muted)]">{formatDateTime(report.createdAt)}</td>
                  <td className="cell-cozy">
                    <ReportStatusBadge status={report.status} />
                  </td>
                  <td className="cell-cozy text-right">
                    <Link to={resumeRouteForStatus(report.id, report.status)} className="font-semibold text-brand-300 hover:text-brand-200">
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
