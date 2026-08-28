import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { buildReport, getReport } from '../../api/client';
import type { RankingReport } from '../../api/types';

function MovementList({ title, items, accent }: { title: string; items: { keyword: string; note: string }[]; accent: string }) {
  if (items.length === 0) return null;
  return (
    <Card className="mt-4 p-6">
      <div className="flex items-center gap-2">
        <p className="text-base font-bold text-[var(--color-ink)]">{title}</p>
        <span className={`rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${accent}`}>
          {title.toLowerCase()}
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {items.map((item, index) => (
          <div key={index} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
            <p className="text-sm font-semibold text-[var(--color-ink)]">{item.keyword}</p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{item.note}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AnalystInsightsPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    getReport(reportId).then(setReport);
  }, [reportId]);

  async function handleBuildReport() {
    if (!reportId) return;
    setBuilding(true);
    setError(null);
    try {
      await buildReport(reportId);
      navigate(`/reports/${reportId}/preview`);
    } catch (err) {
      setError((err as Error).message);
      setBuilding(false);
    }
  }

  if (!report) {
    return (
      <AppShell>
        <ReportWorkingCard label="Loading..." />
      </AppShell>
    );
  }

  const analysis = report.analysisJson;

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: 'Analytics', to: `/reports/${reportId}/analytics` }, { label: 'Analyst Insights' }]}
        action={
          <Button disabled={building || !analysis} onClick={handleBuildReport}>
            {building && <Spinner />}
            Build Report &rarr;
          </Button>
        }
      />

      <div className="mt-6 flex items-center gap-3">
        <PageTitle title="Analyst Insights" />
        <span className="mt-6 inline-flex items-center rounded-full bg-[var(--color-ai-500)]/15 px-3 py-1.5 text-xs font-semibold tracking-wide text-[var(--color-ai-300)]">
          AI &middot; Claude
        </span>
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      {analysis ? (
        <>
          <Card className="mt-4 p-6">
            <div className="flex items-center gap-2">
              <p className="text-base font-bold text-[var(--color-ink)]">Overall Narrative</p>
              <span className="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                narrative
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">{analysis.overallNarrative}</p>
          </Card>

          {analysis.keyInsights.length > 0 && (
            <Card className="mt-4 p-6">
              <p className="text-base font-bold text-[var(--color-ink)]">Key Insights</p>
              <ul className="mt-3 flex flex-col gap-1.5">
                {analysis.keyInsights.map((insight, index) => (
                  <li key={index} className="text-sm text-[var(--color-ink-muted)]">
                    &bull; {insight}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <MovementList title="Key Wins" items={analysis.notableWins} accent="text-brand-300" />
          <MovementList title="Key Losses" items={analysis.notableLosses} accent="text-rose-300" />
        </>
      ) : (
        <p className="mt-6 text-sm text-[var(--color-ink-muted)]">No analysis yet.</p>
      )}
    </AppShell>
  );
}
