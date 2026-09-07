import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { ReportPdfPreview } from '../../components/report/ReportPdfPreview';
import { resumeRouteForStatus } from '../../components/report/reportFlowRoute';
import { canGenerateEmailDraft } from '../../components/report/reportStatus';
import { useActiveClient } from '../../context/ClientContext';
import { generateEmailDraft, getReport } from '../../api/client';
import type { RankingReport } from '../../api/types';

export function ReportPreviewWizardPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    // Guarded on the initial fetch only (not re-run on every local state
    // update from this page's own actions) -- if Build Report was never
    // run yet, there's no PDF to show; send the user back to where they
    // can build one instead of rendering a broken preview.
    getReport(reportId).then((r) => {
      if (!r.clientPdfPath) {
        navigate(resumeRouteForStatus(reportId, r.status), { replace: true });
        return;
      }
      setReport(r);
    });
  }, [reportId]);

  async function handleContinueToEmail() {
    if (!reportId || drafting || !report) return; // guard against double-clicks/duplicate requests
    if (!canGenerateEmailDraft(report.status)) {
      // A draft was already generated (the user went Back to Report
      // Preview after reaching Email Draft, then clicked Next: Email
      // again) -- generate-email-draft only accepts REPORT_READY, so
      // re-calling it here would throw an invalid-transition error. Just
      // resume on the existing draft instead of re-running Claude.
      navigate(`/reports/${reportId}/email`);
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const result = await generateEmailDraft(reportId);
      if (result.outcome !== 'SUCCESS') {
        setError(result.errorMessage ?? `Email draft generation failed (${result.outcome}).`);
        setDrafting(false);
        return;
      }
      navigate(`/reports/${reportId}/email`);
    } catch (err) {
      setError((err as Error).message);
      setDrafting(false);
    }
  }

  if (!report || !reportId) {
    return (
      <AppShell>
        <ReportWorkingCard label="Loading..." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: '← Back to Analytics', to: `/reports/${reportId}/analytics` }, { label: 'Report Preview' }]}
        action={
          <Button disabled={drafting} onClick={handleContinueToEmail}>
            {drafting && <Spinner />}
            Next: Email &rarr;
          </Button>
        }
      />

      <div className="mt-6 flex items-center gap-3">
        <PageTitle title="Report Preview" subtitle={activeClient ? `Client: ${activeClient.name}` : undefined} />
      </div>

      {error && (
        <div className="mt-4">
          <ReportErrorBanner message={error} />
        </div>
      )}

      <div className="mt-6">
        <ReportPdfPreview reportId={reportId} />
      </div>
    </AppShell>
  );
}
