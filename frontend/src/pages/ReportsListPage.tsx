import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { ReportStatusBadge } from '../components/report/ReportStatusBadge';
import { useActiveClient } from '../context/ClientContext';
import { getReports } from '../api/client';
import type { RankingReportListItem, ReportStatus } from '../api/types';

function resumeRoute(report: RankingReportListItem): string {
  switch (report.status as ReportStatus) {
    case 'PENDING_ANALYSIS':
    case 'ANALYSIS_FAILED':
      return `/reports/${report.id}/analytics`;
    case 'ANALYSIS_READY':
      return `/reports/${report.id}/insights`;
    case 'REPORT_READY':
      return `/reports/${report.id}/preview`;
    case 'EMAIL_DRAFT_FAILED':
    case 'EMAIL_DRAFTED':
    case 'PENDING_APPROVAL':
      return `/reports/${report.id}/email`;
    default:
      return `/reports/${report.id}/send`;
  }
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ReportsListPage() {
  const { activeClient } = useActiveClient();
  const [reports, setReports] = useState<RankingReportListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeClient) return;
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
          <p className="p-6 text-sm text-[var(--color-ink-muted)]">Loading...</p>
        ) : reports.length === 0 ? (
          <p className="p-6 text-sm text-[var(--color-ink-muted)]">
            No reports yet. Generate one from a completed run's detail page.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">
                <th className="px-6 py-3.5">Report</th>
                <th className="px-6 py-3.5">From run</th>
                <th className="px-6 py-3.5">Created</th>
                <th className="px-6 py-3.5">Status</th>
                <th className="px-6 py-3.5" />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="px-6 py-4 font-mono text-blue-300">#{report.id.slice(0, 8)}</td>
                  <td className="px-6 py-4 text-[var(--color-ink)]">{report.run.sourceFilename}</td>
                  <td className="px-6 py-4 text-[var(--color-ink-muted)]">{formatDateTime(report.createdAt)}</td>
                  <td className="px-6 py-4">
                    <ReportStatusBadge status={report.status} />
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to={resumeRoute(report)} className="font-semibold text-brand-300 hover:text-brand-200">
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
