import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { StatTile } from '../../components/ui/StatTile';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { isReportAlreadyBuilt } from '../../components/report/reportStatus';
import { Badge } from '../../components/ui/Badge';
import { AlertPanel } from '../../components/ui/AlertPanel';
import { VerifiedExcelUploadModal } from '../../components/report/VerifiedExcelUploadModal';
import { describeReportGeneration, type ReportGenerationNoticeState } from '../../components/report/reportGenerationNotice';
import { buildReport, getReport, regenerateReport } from '../../api/client';
import { formatReportDate } from '../../utils/formatters';
import type { RankingReport, ReportStatus } from '../../api/types';

/** A report stops being editable once it's being sent, has been sent, or was rejected. */
const LOCKED_STATUSES: ReportStatus[] = ['SENDING', 'SENT', 'REJECTED'];

export function AnalyticsPreviewPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const [notice, setNotice] = useState<string | null>((location.state as ReportGenerationNoticeState | null)?.generationNotice ?? null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (!reportId) return;
    // Clear stale state from a PREVIOUSLY viewed report before fetching --
    // this route doesn't remount on a param-only navigation between two
    // different reportIds, so without this the old report's data (or a
    // stale build-report error) could render for a frame under this URL.
    setReport(null);
    setError(null);
    setGenerating(false);
    getReport(reportId).then(setReport);
  }, [reportId]);

  async function handleRegenerate() {
    if (!reportId || regenerating) return;
    const ok = window.confirm(
      'Regenerate this report?\n\nThe comparison, PDF and email subject/body are rebuilt with today’s date. Recipients and CC stay as they are.',
    );
    if (!ok) return;
    setRegenerating(true);
    setError(null);
    setNotice(null);
    try {
      const { summary } = await regenerateReport(reportId);
      setReport(await getReport(reportId));
      setNotice(describeReportGeneration(summary));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegenerating(false);
    }
  }

  async function handleUploaded(updated: RankingReport, summary: Parameters<typeof describeReportGeneration>[0]) {
    setUploadOpen(false);
    setError(null);
    setReport(await getReport(updated.id));
    setNotice(describeReportGeneration(summary));
  }

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
  // Email is auto-drafted by the verified-Excel upload pipeline
  // (processVerifiedExcelUpload.ts) -- once the report has moved past
  // REPORT_READY, an email draft already exists and is sitting in (or past)
  // the approval queue, so offer a direct shortcut there alongside the PDF.
  const emailAlreadyDrafted = report.status !== 'PENDING_ANALYSIS' && report.status !== 'ANALYSIS_FAILED' && report.status !== 'ANALYSIS_READY' && report.status !== 'REPORT_READY';
  const locked = LOCKED_STATUSES.includes(report.status);
  const busy = regenerating || generating;
  const currentDateLabel = report.reportDate ? formatReportDate(report.reportDate) : 'the latest run';

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: '← Back to Run', to: `/runs/${report.runId}` }, { label: 'Analytics Preview' }]}
        action={
          alreadyBuilt ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!locked && (
                <>
                  <Button variant="ghost" disabled={busy} onClick={handleRegenerate} title="Rebuild the comparison, PDF and email with today’s date">
                    {regenerating && <Spinner />}
                    Regenerate
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setUploadOpen(true)}>
                    Upload Updated Excel
                  </Button>
                </>
              )}
              <Button variant={emailAlreadyDrafted ? 'secondary' : undefined} onClick={() => navigate(`/reports/${reportId}/preview`)}>
                View Report Preview &rarr;
              </Button>
              {emailAlreadyDrafted && <Button onClick={() => navigate(`/reports/${reportId}/send`)}>Send Email &rarr;</Button>}
            </div>
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
        <Badge tone="neutral" className="mt-6">
          Backend &middot; No AI
        </Badge>
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      {notice && (
        <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      )}

      <AlertPanel tone="info" className="mt-4 text-sm text-[var(--color-ink-muted)]">
        {report.previousBaseline ? (
          <p>
            Comparing <span className="font-semibold text-[var(--color-ink)]">{currentDateLabel}</span> against{' '}
            <span className="font-semibold text-[var(--color-ink)]">{formatReportDate(report.previousBaseline.baselineDate)}</span>
            <span className="text-[var(--color-ink-faint)]"> · from {report.previousBaseline.sourceFilename}</span>
          </p>
        ) : report.previousRunId ? (
          <p>
            Comparing <span className="font-semibold text-[var(--color-ink)]">{currentDateLabel}</span> against an earlier run.
          </p>
        ) : (
          <p>No earlier ranking found for this client, so this first report shows current ranks only.</p>
        )}
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
          {locked
            ? report.status === 'SENT'
              ? 'Sent to the client — this report is locked.'
              : report.status === 'SENDING'
                ? 'Sending now — changes are paused until it finishes.'
                : 'This report was rejected and can’t be changed.'
            : 'Need a fix? Upload an updated Excel or click Regenerate — as often as you like. The comparison above stays the same, and these ranks only become the client’s new baseline once you send.'}
        </p>
      </AlertPanel>

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
                Keyword Movement
                {report.previousRunId && ` · vs #${report.previousRunId.slice(0, 8)}`}
                {report.previousBaseline && ` · vs baseline: ${report.previousBaseline.sourceFilename}`}
              </p>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] eyebrow-label">
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
      <VerifiedExcelUploadModal
        open={uploadOpen}
        runId={report.runId}
        updatingExisting
        onClose={() => setUploadOpen(false)}
        onProcessed={(updated, summary) => void handleUploaded(updated, summary)}
      />
    </AppShell>
  );
}
