import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { InlineError } from '../../components/ui/InlineError';
import { AlertPanel } from '../../components/ui/AlertPanel';
import { useActiveClient } from '../../context/ClientContext';
import { createReport, getBaselines, getReport, getRuns } from '../../api/client';
import { resumeRouteForStatus } from '../../components/report/reportFlowRoute';
import { formatDate } from '../../utils/formatters';
import type { BaselineRecord, RankingRun } from '../../api/types';

const REPORTABLE = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS']);

// Comparison dropdown values are prefixed so a single flat Select can offer
// both prior runs and saved baselines without the two id spaces colliding --
// "" keeps the existing default (server picks the latest run, or falling
// back to the latest baseline, per createReportForRun).
const RUN_PREFIX = 'run:';
const BASELINE_PREFIX = 'baseline:';

export function GenerateReportPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();

  const [priorRuns, setPriorRuns] = useState<RankingRun[]>([]);
  const [baselines, setBaselines] = useState<BaselineRecord[]>([]);
  const [comparisonValue, setComparisonValue] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeClient || !runId) return;
    getRuns(activeClient.id).then((runs) => {
      const eligible = runs.filter((r) => r.id !== runId && REPORTABLE.has(r.status));
      setPriorRuns(eligible);
      if (eligible.length > 0) setComparisonValue(`${RUN_PREFIX}${eligible[0].id}`);
    });
    getBaselines(activeClient.id).then(setBaselines);
  }, [activeClient, runId]);

  async function handleContinue() {
    if (!runId) return;
    setSubmitting(true);
    setError(null);
    try {
      const previousRunId = comparisonValue.startsWith(RUN_PREFIX) ? comparisonValue.slice(RUN_PREFIX.length) : undefined;
      const previousBaselineId = comparisonValue.startsWith(BASELINE_PREFIX) ? comparisonValue.slice(BASELINE_PREFIX.length) : undefined;
      const result = await createReport(runId, previousRunId, previousBaselineId);
      if (result.outcome === 'CREATED') {
        navigate(`/reports/${result.report.id}/analytics`);
        return;
      }
      if (result.outcome === 'DUPLICATE') {
        // A report already exists for this run -- resume from wherever it
        // actually is (it may already be past Analytics Preview), instead
        // of dumping the user back at the start and inviting them to
        // re-trigger a step that's already done.
        const existing = await getReport(result.existingReportId);
        navigate(resumeRouteForStatus(existing.id, existing.status));
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
      <PageHeader breadcrumbs={[{ label: '← Back to Run', to: `/runs/${runId}` }, { label: 'Generate Report' }]} />
      <PageTitle title="Generate SEO Report" subtitle={runId ? `Run #${runId.slice(0, 8)}` : undefined} />

      <Card className="mt-6 p-6">
        <p className="eyebrow-label">Compare against</p>
        <div className="mt-1.5">
          <Select
            value={comparisonValue}
            onChange={setComparisonValue}
            placeholder="Automatic (latest run, or latest baseline)"
            options={[
              ...priorRuns.map((r) => ({
                value: `${RUN_PREFIX}${r.id}`,
                label: `Run #${r.id.slice(0, 8)} — ${formatDate(r.createdAt)}`,
              })),
              ...baselines.map((b) => ({
                value: `${BASELINE_PREFIX}${b.id}`,
                label: `Baseline: ${b.sourceFilename} — uploaded ${formatDate(b.createdAt)}`,
              })),
            ]}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          Adds keyword movement deltas to analytics. Pick a prior run, or a saved previous-rank baseline uploaded from
          Client Management. Leave as Automatic to use the latest run (falling back to the latest baseline if this is
          the client's first run). Recommended.
        </p>

        <AlertPanel tone="info" className="mt-5">
          <p className="text-sm text-[var(--color-ink-muted)]">
            This creates a report record and takes you to analytics. Everything here is computed directly from the ranking data -- no AI involved anywhere in this flow.
          </p>
        </AlertPanel>

        <InlineError message={error} className="mt-4" />

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
