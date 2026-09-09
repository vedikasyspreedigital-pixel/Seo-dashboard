import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportStatusBadge } from '../../components/report/ReportStatusBadge';
import { ReportPdfPreview } from '../../components/report/ReportPdfPreview';
import { InlineError } from '../../components/ui/InlineError';
import { BackLink } from '../../components/ui/BackLink';
import { TextInput } from '../../components/ui/TextInput';
import { AlertPanel } from '../../components/ui/AlertPanel';
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
    // Reset ALL per-report local state the instant reportId changes, before
    // the fetch even starts -- this route (/reports/:reportId/send) doesn't
    // remount on a param-only change, so without this a `sent`/`error` flag
    // left over from a PREVIOUSLY viewed report would otherwise persist and
    // misrepresent the newly-viewed report (e.g. showing "Report sent" for
    // a report that was never sent, permanently, since nothing else ever
    // clears `sent` back to false).
    setReport(null);
    setSent(false);
    setError(null);
    setSending(false);
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
          <BackLink to="/reports" label="Back to Reports" />
        </Card>
      </AppShell>
    );
  }

  if (sent || report.status === 'SENT') {
    // Read-only: every value below comes straight off the stored report row
    // (getReport -> GET /api/reports/:id) -- nothing here is regenerated,
    // re-derived, or re-fetched from anywhere else. The PDF below is the
    // same GET /api/reports/:id/pdf stream used everywhere else in the app,
    // which only ever reads the file buildReport already wrote to disk.
    const sentRecipients = report.resolvedRecipients ?? [];
    const sentCc = report.resolvedCc ?? [];
    return (
      <AppShell>
        <PageHeader breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Sent Report Details' }]} />
        <div className="mt-6 flex items-center gap-3">
          <PageTitle title="Sent Report Details" subtitle="Exactly what was stored and sent -- read-only." />
          <ReportStatusBadge status="SENT" />
        </div>

        {report.auditCommentPosted === false && (
          <AlertPanel tone="warning" className="mt-4">
            <p className="text-sm text-amber-300">
              The email itself was sent successfully -- only the follow-up ClickUp audit-trail comment failed to post. This does not affect delivery.
            </p>
          </AlertPanel>
        )}

        <Card className="mt-6 p-6">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">Sent</span>
              <span className="text-right text-[var(--color-ink)] sm:block sm:text-left">{report.sentAt ? new Date(report.sentAt).toLocaleString() : '—'}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">Approved by</span>
              <span className="text-right text-[var(--color-ink)] sm:block sm:text-left">{report.approvedBy ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">To</span>
              <span className="text-right text-[var(--color-ink)] sm:block sm:text-left">{sentRecipients.length > 0 ? sentRecipients.join(', ') : '—'}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">Cc</span>
              <span className="text-right text-[var(--color-ink)] sm:block sm:text-left">{sentCc.length > 0 ? sentCc.join(', ') : '(none)'}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">ClickUp task</span>
              <span className="text-right sm:block sm:text-left">
                {report.resolvedClickupTaskUrl ? (
                  <a href={report.resolvedClickupTaskUrl} target="_blank" rel="noreferrer" className="text-brand-300 hover:text-brand-200">
                    {report.resolvedClickupTaskUrl}
                  </a>
                ) : (
                  <span className="text-[var(--color-ink)]">—</span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-[var(--color-ink-faint)]">Report</span>
              <span className="text-right text-[var(--color-ink)] sm:block sm:text-left">#{report.id.slice(0, 8)}</span>
            </div>
          </div>

          <div className="mt-5">
            <p className="eyebrow-label">Subject</p>
            <p className="mt-1.5 text-sm text-[var(--color-ink)]">{report.emailSubject ?? '—'}</p>
          </div>

          <div className="mt-5">
            <p className="eyebrow-label">Body</p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-[var(--color-ink)]">{report.emailBody ?? '—'}</p>
          </div>

          <BackLink to="/reports" label="Back to Reports" />
        </Card>

        <div className="mt-4">
          <p className="eyebrow-label mb-2">Attached report (PDF)</p>
          <ReportPdfPreview reportId={report.id} />
        </div>
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
          <TextInput type="text" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className="max-w-xs" />
        </div>

        <AlertPanel tone="warning" className="mt-5 flex items-start gap-2.5">
          <p className="text-sm text-amber-300">This report will be emailed and marked Sent. This cannot be undone.</p>
        </AlertPanel>

        <InlineError message={error} className="mt-4" />

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
