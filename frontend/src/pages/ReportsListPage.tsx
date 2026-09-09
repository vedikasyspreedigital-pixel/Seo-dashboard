import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { ReportStatusBadge } from '../components/report/ReportStatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { useActiveClient } from '../context/ClientContext';
import { getReports } from '../api/client';
import { resumeRouteForStatus } from '../components/report/reportFlowRoute';
import { formatDateTime } from '../utils/formatters';
import type { RankingReportListItem } from '../api/types';

export function ReportsListPage() {
  const { activeClient } = useActiveClient();
  const [reports, setReports] = useState<RankingReportListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeClient) {
      setReports([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getReports(activeClient.id)
      .then((data) => {
        if (!cancelled) setReports(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeClient]);

  return (
    <AppShell>
      <PageHeader breadcrumbs={[{ label: activeClient?.name ?? '...' }, { label: 'Reports' }]} />
      <PageTitle title="Client Reports" subtitle={activeClient ? `${activeClient.name} · ${reports.length} report${reports.length === 1 ? '' : 's'}` : undefined} />

      <Card className="mt-6 overflow-hidden p-0">
        {loading ? (
          <EmptyState label="Loading..." />
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
