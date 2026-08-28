import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { useActiveClient } from '../../context/ClientContext';
import { createReport, getRuns } from '../../api/client';
import type { RankingRun } from '../../api/types';

const REPORTABLE = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS']);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function GenerateReportPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();

  const [priorRuns, setPriorRuns] = useState<RankingRun[]>([]);
  const [previousRunId, setPreviousRunId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeClient || !runId) return;
    getRuns(activeClient.id).then((runs) => {
      const eligible = runs.filter((r) => r.id !== runId && REPORTABLE.has(r.status));
      setPriorRuns(eligible);
      if (eligible.length > 0) setPreviousRunId(eligible[0].id);
    });
  }, [activeClient, runId]);

  async function handleContinue() {
    if (!runId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createReport(runId, previousRunId || undefined);
      if (result.outcome === 'CREATED') {
        navigate(`/reports/${result.report.id}/analytics`);
        return;
      }
      if (result.outcome === 'DUPLICATE') {
        navigate(`/reports/${result.existingReportId}/analytics`);
        return;
      }
      setError(result.outcome === 'RUN_NOT_FOUND' ? 'Run not found.' : result.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader breadcrumbs={[{ label: 'Run', to: `/runs/${runId}` }, { label: 'Generate Report' }]} />
      <PageTitle title="Generate SEO Report" subtitle={runId ? `Run #${runId.slice(0, 8)}` : undefined} />

      <Card className="mt-6 p-6">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Compare against previous run</p>
        <div className="mt-1.5">
          <Select
            value={previousRunId}
            onChange={setPreviousRunId}
            placeholder="None"
            options={priorRuns.map((r) => ({ value: r.id, label: `#${r.id.slice(0, 8)} — ${formatDate(r.createdAt)}` }))}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Adds keyword movement deltas to analytics. Recommended.</p>

        <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <p className="text-sm text-[var(--color-ink-muted)]">
            This creates a report record and takes you to analytics. The Claude call happens only when you generate insights.
          </p>
        </div>

        {error && <p className="mt-4 text-sm font-medium text-rose-300">{error}</p>}

        <div className="mt-6 flex items-center gap-3">
          <Button disabled={submitting} onClick={handleContinue}>
            {submitting && <Spinner />}
            Continue
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/runs/${runId}`)}>
            Cancel
          </Button>
        </div>
      </Card>
    </AppShell>
  );
}
