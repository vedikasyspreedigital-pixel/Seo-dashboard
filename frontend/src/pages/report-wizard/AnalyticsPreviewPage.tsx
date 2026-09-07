import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { StatTile } from '../../components/ui/StatTile';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { isReportAlreadyBuilt } from '../../components/report/reportStatus';
import { buildReport, getReport } from '../../api/client';
import type { RankingReport } from '../../api/types';

export function AnalyticsPreviewPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    getReport(reportId).then(setReport);
  }, [reportId]);

  async function handleBuildReport() {
    if (!reportId || generating) return; // guard against double-clicks/duplicate requests
    setGenerating(true);
    setError(null);
    try {
      await buildReport(reportId);
      navigate(`/reports/${reportId}/preview`);
    } catch (err) {
      setError((err as Error).message);
      setGenerating(false);
    }
  }

  if (!report) {
    return (
      <AppShell>
        <ReportWorkingCard label="Loading..." />
      </AppShell>
    );
  }

  const analytics = report.analyticsJson;
  const alreadyBuilt = isReportAlreadyBuilt(report.status);

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: '← Back to Run', to: `/runs/${report.runId}` }, { label: 'Analytics Preview' }]}
        action={
          alreadyBuilt ? (
            <Button onClick={() => navigate(`/reports/${reportId}/preview`)}>View Report Preview &rarr;</Button>
          ) : (
            <Button disabled={generating} onClick={handleBuildReport}>
              {generating && <Spinner />}
              Build Report &rarr;
            </Button>
          )
        }
      />

      <div className="mt-6 flex items-center gap-3">
        <PageTitle title="Analytics Preview" />
        <span className="mt-6 inline-flex items-center rounded-full bg-[var(--color-surface-3)] px-3 py-1.5 text-xs font-semibold tracking-wide text-[var(--color-ink-muted)]">
          Backend &middot; No AI
        </span>
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      {analytics && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="Total Keywords" value={analytics.totals.totalKeywords} />
            <StatTile label="Avg Rank" value={analytics.totals.averageRank ?? '—'} accent="text-blue-300" />
            <StatTile label="Top 3" value={analytics.totals.top3Count} accent="text-brand-300" />
            <StatTile label="Top 10" value={analytics.totals.top10Count} accent="text-blue-300" />
            <StatTile label="Not in 100" value={analytics.totals.notIn100Count} accent="text-rose-300" />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Improved" value={analytics.movements.improved.length} accent="text-brand-300" />
            <StatTile label="Declined" value={analytics.movements.declined.length} accent="text-rose-300" />
            <StatTile label="Unchanged" value={analytics.movements.unchanged.length} />
            <StatTile label="Newly Tracked" value={analytics.movements.newlyTracked.length} accent="text-blue-300" />
          </div>

          {(analytics.movements.improved.length > 0 || analytics.movements.declined.length > 0) && (
            <Card className="mt-4 overflow-hidden p-0">
              <p className="px-6 pt-5 text-sm font-semibold text-[var(--color-ink)]">
                Keyword Movement{report.previousRunId && ` · vs #${report.previousRunId.slice(0, 8)}`}
              </p>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">
                    <th className="px-6 py-3">Keyword</th>
                    <th className="px-6 py-3">Previous</th>
                    <th className="px-6 py-3">Current</th>
                    <th className="px-6 py-3">&Delta;</th>
                  </tr>
                </thead>
                <tbody>
                  {[...analytics.movements.improved, ...analytics.movements.declined].map((m) => (
                    <tr key={m.rowUid} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-6 py-3 text-[var(--color-ink)]">{m.keyword}</td>
                      <td className="px-6 py-3 font-mono text-[var(--color-ink-muted)]">{m.previousRank ?? 'Not in 100'}</td>
                      <td className="px-6 py-3 font-mono text-[var(--color-ink)]">{m.currentRank ?? 'Not in 100'}</td>
                      <td className={`px-6 py-3 font-mono ${m.delta !== null && m.delta > 0 ? 'text-brand-300' : m.delta !== null && m.delta < 0 ? 'text-rose-300' : 'text-[var(--color-ink-muted)]'}`}>
                        {m.delta !== null ? (m.delta > 0 ? `↑${m.delta}` : m.delta < 0 ? `↓${Math.abs(m.delta)}` : '—') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="h-4" />
            </Card>
          )}
        </>
      )}
    </AppShell>
  );
}
