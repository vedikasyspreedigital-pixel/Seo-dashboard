import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportLoadFailed } from '../../components/report/ReportLoadFailed';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { EmailDraftEditor } from '../../components/report/EmailDraftEditor';
import { EmailTemplateToggle } from '../../components/report/EmailTemplateToggle';
import { ExtraAttachmentsCard } from '../../components/report/ExtraAttachmentsCard';
import { Badge } from '../../components/ui/Badge';
import { resumeRouteForStatus } from '../../components/report/reportFlowRoute';
import { canRegenerate, canApproveOrReject, isDraftEditable } from '../../components/report/reportStatus';
import { getReport, regenerateEmailDraft, rejectReport, setEmailVariant, updateReportDraft, type UpdateReportDraftInput } from '../../api/client';
import type { EmailVariant, RankingReport } from '../../api/types';

export function EmailDraftPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [busy, setBusy] = useState(false);
  // Save Changes gets its own in-flight flag (in addition to the shared
  // `busy` used to keep Save/Regenerate/Reject mutually exclusive) so its
  // button label reflects THIS action specifically, not whichever of the
  // three happens to be running.
  const [savingDraft, setSavingDraft] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!reportId) return;
    // Guarded on the initial fetch only -- not re-run on every local state
    // update from Save/Regenerate/Reject below, so a Regenerate failure
    // (which leaves emailSubject null, same as "no draft yet") never yanks
    // the user off the page they're actively looking at.
    getReport(reportId)
      .then((r) => {
        const hasDraft = Boolean(r.clientPdfPath) && (Boolean(r.emailSubject) || r.status === 'EMAIL_DRAFT_FAILED');
        if (!hasDraft) {
          navigate(resumeRouteForStatus(reportId, r.status), { replace: true });
          return;
        }
        setReport(r);
      })
      .catch((err: Error) => setLoadError(err.message || 'Something went wrong.'));
  }, [reportId, loadAttempt]);

  async function refresh() {
    if (!reportId) return;
    const updated = await getReport(reportId);
    setReport(updated);
    return updated;
  }

  async function handleSave(edits: UpdateReportDraftInput) {
    if (!reportId || busy) return; // guard against double-clicks/duplicate requests
    setBusy(true);
    setSavingDraft(true);
    setError(null);
    setJustSaved(false);
    try {
      // The actual persistence: PATCH /api/reports/:id -> updateReportDraft
      // -> prisma.rankingReport.update. setReport(updated) below replaces
      // local state with exactly what the backend just confirmed it wrote
      // -- not merely echoing back the form values -- so a refresh or
      // re-navigation to this page reads the same persisted values back
      // from GET /api/reports/:id.
      const updated = await updateReportDraft(reportId, edits);
      setReport(updated);
      setJustSaved(true);
    } catch (err) {
      // Deliberately do NOT touch `report` here -- EmailDraftEditor's form
      // state stays exactly as the user left it (it only resyncs from
      // `report`, which is untouched on failure), so a failed save never
      // loses the user's edits and never shows a false "Saved".
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setSavingDraft(false);
    }
  }

  async function handleRegenerate() {
    if (!reportId || busy || !report || !canRegenerate(report.status)) return;
    setBusy(true);
    setError(null);
    setJustSaved(false); // a different action ran -- any prior "Saved" label is stale
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

  async function handleTemplateChange(variant: EmailVariant) {
    if (!reportId || busy || !report) return;
    const label = variant === 'ga' ? 'Google Analytics' : 'Regular';
    if (!window.confirm(`Switch to the ${label} email? The email body will be replaced by the ${label} template -- the subject, recipients and CC stay as they are. Unsaved changes to the body will be lost.`)) return;
    setBusy(true);
    setError(null);
    setJustSaved(false);
    try {
      setReport(await setEmailVariant(reportId, variant));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!reportId || busy || !report || !canApproveOrReject(report.status)) return;
    setBusy(true);
    setError(null);
    setJustSaved(false);
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
        {loadError ? <ReportLoadFailed message={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} /> : <ReportWorkingCard label="Loading..." />}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: '← Back to Report Preview', to: `/reports/${reportId}/preview` }, { label: 'Email Draft' }]}
        action={
          <Button disabled={busy} onClick={() => !busy && navigate(`/reports/${reportId}/send`)}>
            Preview Send &rarr;
          </Button>
        }
      />

      <div className="mt-6 flex items-center gap-3">
        <PageTitle title="Email Draft" />
        <Badge tone="neutral" className="mt-6">
          Template &middot; Editable
        </Badge>
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      <div className="mt-6">
        <EmailTemplateToggle value={report.emailVariant ?? 'regular'} onChange={(v) => void handleTemplateChange(v)} disabled={busy || !isDraftEditable(report.status)} />
      </div>

      <div className="mt-4">
        <EmailDraftEditor
          report={report}
          onSave={handleSave}
          saving={savingDraft}
          disabled={busy}
          justSaved={justSaved}
        />
      </div>

      <div className="mt-4">
        <ExtraAttachmentsCard report={report} editable={isDraftEditable(report.status) && !busy} onChange={setReport} />
      </div>

      {(canRegenerate(report.status) || canApproveOrReject(report.status)) && (
        <div className="mt-4 flex items-center gap-3">
          {canRegenerate(report.status) && (
            <Button variant="secondary" disabled={busy} onClick={handleRegenerate}>
              {busy && <Spinner />}
              Regenerate Draft
            </Button>
          )}
          {canApproveOrReject(report.status) && (
            <Button variant="danger" disabled={busy} onClick={handleReject}>
              Reject
            </Button>
          )}
        </div>
      )}
    </AppShell>
  );
}
