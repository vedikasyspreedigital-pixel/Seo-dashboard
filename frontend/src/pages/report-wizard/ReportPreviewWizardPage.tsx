import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportErrorBanner } from '../../components/report/ReportErrorBanner';
import { ReportPreview } from '../../components/report/ReportPreview';
import { generateEmailDraft, getReport } from '../../api/client';
import type { RankingReport } from '../../api/types';

export function ReportPreviewWizardPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    getReport(reportId).then(setReport);
  }, [reportId]);

  async function handleContinueToEmail() {
    if (!reportId) return;
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
        breadcrumbs={[{ label: 'Insights', to: `/reports/${reportId}/insights` }, { label: 'Report Preview' }]}
        action={
          <Button disabled={drafting} onClick={handleContinueToEmail}>
            {drafting && <Spinner />}
            Continue to Email &rarr;
          </Button>
        }
      />
      <PageTitle title="Report Preview" />

      {error && <ReportErrorBanner message={error} />}

      <div className="mt-6">
        <ReportPreview report={report} />
      </div>
    </AppShell>
  );
}
