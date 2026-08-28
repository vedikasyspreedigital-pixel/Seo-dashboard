import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { EmailDraftEditor } from '../../components/report/EmailDraftEditor';
import { getReport, regenerateEmailDraft, rejectReport, updateReportDraft, type UpdateReportDraftInput } from '../../api/client';
import type { RankingReport } from '../../api/types';

export function EmailDraftPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    getReport(reportId).then(setReport);
  }, [reportId]);

  async function refresh() {
    if (!reportId) return;
    const updated = await getReport(reportId);
    setReport(updated);
    return updated;
  }

  async function handleSave(edits: UpdateReportDraftInput) {
    if (!reportId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateReportDraft(reportId, edits);
      setReport(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    if (!reportId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await regenerateEmailDraft(reportId);
      await refresh();
      if (result.outcome !== 'SUCCESS') {
        setError(`Regenerate failed (${result.outcome}).`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!reportId) return;
    setBusy(true);
    setError(null);
    try {
      await rejectReport(reportId);
      navigate(`/reports/${reportId}/send`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!report) {
    return (
      <AppShell>
        <ReportWorkingCard label="Loading..." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: 'Report Preview', to: `/reports/${reportId}/preview` }, { label: 'Email Draft' }]}
        action={
          <Button disabled={busy} onClick={() => navigate(`/reports/${reportId}/send`)}>
            Preview Send &rarr;
          </Button>
        }
      />

      <div className="mt-6 flex items-center gap-3">
        <PageTitle title="Email Draft" />
        <span className="mt-6 inline-flex items-center rounded-full bg-[var(--color-ai-500)]/15 px-3 py-1.5 text-xs font-semibold tracking-wide text-[var(--color-ai-300)]">
          AI-drafted &middot; Claude
        </span>
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      <div className="mt-6">
        <EmailDraftEditor report={report} onSave={handleSave} saving={busy} />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="secondary" disabled={busy} onClick={handleRegenerate}>
          {busy && <Spinner />}
          Regenerate Draft
        </Button>
        <Button variant="danger" disabled={busy} onClick={handleReject}>
          Reject
        </Button>
      </div>
    </AppShell>
  );
}
