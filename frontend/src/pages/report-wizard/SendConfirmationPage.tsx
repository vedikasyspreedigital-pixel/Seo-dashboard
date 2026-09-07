import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { resumeRouteForStatus } from '../../components/report/reportFlowRoute';
import { approveAndSendReport, getReport } from '../../api/client';
import type { RankingReport } from '../../api/types';

const SEND_PAGE_STATUSES: RankingReport['status'][] = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT'];

export function SendConfirmationPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [approvedBy, setApprovedBy] = useState('Admin');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!reportId) return;
    // Guarded on the initial fetch only -- an email draft must have been
    // submitted for approval before this page has anything to show.
    getReport(reportId).then((r) => {
      if (!SEND_PAGE_STATUSES.includes(r.status)) {
        navigate(resumeRouteForStatus(reportId, r.status), { replace: true });
        return;
      }
      setReport(r);
    });
  }, [reportId]);

  async function handleApproveAndSend() {
    if (!reportId || sending) return; // guard against double-clicks/duplicate requests
    setSending(true);
    setError(null);
    try {
      const result = await approveAndSendReport(reportId, approvedBy.trim());
      if (result.outcome !== 'SENT') {
        setError(result.errorMessage ?? `Could not send (${result.outcome}).`);
        setSending(false);
        return;
      }
      // Refresh from the backend rather than relying on local state alone,
      // so e.g. sentAt below reflects what was actually persisted.
      await getReport(reportId).then(setReport);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  }

  if (!report) {
    return (
      <AppShell>
        <ReportWorkingCard label="Loading..." />
      </AppShell>
    );
  }

  if (report.status === 'REJECTED') {
    return (
      <AppShell>
        <PageHeader breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Rejected' }]} />
        <Card className="mt-6 p-6">
          <p className="text-sm text-[var(--color-ink-muted)]">This report was rejected. No email was sent.</p>
          <Link to="/reports" className="mt-3 inline-block text-sm font-semibold text-brand-300 hover:text-brand-200">
            &larr; Back to Reports
          </Link>
        </Card>
      </AppShell>
    );
  }

  if (sent || report.status === 'SENT') {
    return (
      <AppShell>
        <PageHeader breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Sent' }]} />
        <Card className="mt-6 border-brand-400/25 bg-brand-400/[0.05] p-6">
          <p className="font-semibold text-brand-300">Report sent.</p>
          {report.sentAt && <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{new Date(report.sentAt).toLocaleString()}</p>}
          <Link to="/reports" className="mt-3 inline-block text-sm font-semibold text-brand-300 hover:text-brand-200">
            &larr; Back to Reports
          </Link>
        </Card>
      </AppShell>
    );
  }

  const recipients = report.resolvedRecipients ?? [];

  return (
    <AppShell>
      <PageHeader breadcrumbs={[{ label: '← Back to Email Draft', to: `/reports/${reportId}/email` }, { label: 'Send Confirmation' }]} />
      <PageTitle title="Approve & Send" subtitle="This is the only action in this flow that actually sends an email." />

      <Card className="mt-6 p-6">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Send to</span>
            <span className="text-right text-[var(--color-ink)]">{recipients.length > 0 ? recipients.join(', ') : 'No recipients'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Subject</span>
            <span className="text-right text-[var(--color-ink)]">{report.emailSubject ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Report</span>
            <span className="text-right text-[var(--color-ink)]">Ranking report #{report.id.slice(0, 8)}</span>
          </div>
        </div>

        <div className="mt-5">
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Approved by</label>
          <input
            type="text"
            value={approvedBy}
            onChange={(e) => setApprovedBy(e.target.value)}
            className="w-full max-w-xs rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25"
          />
        </div>

        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
          <p className="text-sm text-amber-300">This report will be emailed and marked Sent. This cannot be undone.</p>
        </div>

        {error && <p className="mt-4 text-sm font-medium text-rose-300">{error}</p>}

        <div className="mt-6 flex items-center gap-3">
          <Button disabled={sending || recipients.length === 0 || approvedBy.trim().length === 0} onClick={handleApproveAndSend}>
            {sending && <Spinner />}
            Approve &amp; Send
          </Button>
          <Link to={`/reports/${reportId}/email`}>
            <Button variant="ghost">Cancel</Button>
          </Link>
        </div>
      </Card>
    </AppShell>
  );
}
