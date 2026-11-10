import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/layout/AppShell';
import { PageHeader, PageTitle } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ReportWorkingCard } from '../../components/report/ReportWorkingCard';
import { ReportLoadFailed } from '../../components/report/ReportLoadFailed';
import { ReportStatusBadge } from '../../components/report/ReportStatusBadge';
import { ReportPdfPreview } from '../../components/report/ReportPdfPreview';
import { InlineError } from '../../components/ui/InlineError';
import { BackLink } from '../../components/ui/BackLink';
import { AlertPanel } from '../../components/ui/AlertPanel';
import { resumeRouteForStatus } from '../../components/report/reportFlowRoute';
import { MarkSentManuallyModal } from '../../components/report/MarkSentManuallyModal';
import { ConsolidatedReportInfo } from '../../components/report/ConsolidatedReportInfo';
import { approveAndSendReport, getConsolidatedHistoryFileUrl, getReport } from '../../api/client';
import { useSession } from '../../context/SessionContext';
import type { RankingReport } from '../../api/types';

// SENDING too: a report being sent was bounced to this same page, which never re-loaded -- an endless
// "Loading..." (audit 2026-10-27). It now shows "Sending..." and checks again until it's done.
const SEND_PAGE_STATUSES: RankingReport['status'][] = ['PENDING_APPROVAL', 'APPROVED', 'SENDING', 'REJECTED', 'SENT'];
const SENDING_CHECK_MS = 10_000;

// The ClickUp sender's same-subject block (clickupEmailSender.ts pre-send duplicate guard).
const DUPLICATE_SUBJECT_BLOCK = /already appears in this task's history/i;

// The Google Analytics template's placeholders (backend emailDraft.ts buildGaEmailDraft).
const GA_PLACEHOLDER = /\[(organic search users|event count|month)\]/i;
const GA_PLACEHOLDER_ALL = /\[(organic search users|event count|month)\]/gi;

/** yyyy-mm-dd in local time, for the "date it was sent" field. */
function localDateInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SendConfirmationPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const { user } = useSession();
  const [report, setReport] = useState<RankingReport | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [markingManually, setMarkingManually] = useState(false);

  // While the report is being sent (here or by someone else), check again until it's sent or failed.
  useEffect(() => {
    if (!reportId || report?.status !== 'SENDING') return;
    const timer = setTimeout(() => {
      getReport(reportId)
        .then(setReport)
        .catch(() => setReport((r) => (r ? { ...r } : r))); // a failed check just tries again
    }, SENDING_CHECK_MS);
    return () => clearTimeout(timer);
  }, [reportId, report]);

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
    setMarkingManually(false);
    // Guarded on the initial fetch only -- an email draft must have been
    // submitted for approval before this page has anything to show.
    getReport(reportId)
      .then((r) => {
        if (!SEND_PAGE_STATUSES.includes(r.status)) {
          navigate(resumeRouteForStatus(reportId, r.status), { replace: true });
          return;
        }
        setReport(r);
      })
      .catch((err: Error) => setLoadError(err.message || 'Something went wrong.'));
  }, [reportId, loadAttempt]);

  async function handleApproveAndSend(allowDuplicateSubject = false) {
    if (!reportId || sending) return; // guard against double-clicks/duplicate requests
    setSending(true);
    setError(null);
    try {
      const result = await approveAndSendReport(reportId, { allowDuplicateSubject });
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
        {loadError ? <ReportLoadFailed message={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} /> : <ReportWorkingCard label="Loading..." />}
      </AppShell>
    );
  }

  if (report.status === 'SENDING') {
    return (
      <AppShell>
        <PageHeader breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Sending' }]} />
        <Card className="mt-6 p-6">
          <div className="flex items-center gap-3">
            <Spinner />
            <p className="text-sm text-[var(--color-ink)]">This report is being sent through ClickUp right now.</p>
          </div>
          <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
            This usually takes under a minute. The page checks again every {SENDING_CHECK_MS / 1000} seconds and shows the result here.
          </p>
          <BackLink to="/reports" label="Back to Reports" />
        </Card>
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
    // The latest send was "Mark as sent manually": the client got the team's own file, not the generated PDF.
    const manualSend = report.sends?.[0]?.manual ? report.sends[0] : null;
    const sentCc = report.resolvedCc ?? [];
    return (
      <AppShell>
        <PageHeader breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'Sent Report Details' }]} />
        <div className="mt-6 flex items-center gap-3">
          <PageTitle title="Sent Report Details" subtitle="Exactly what was stored and sent -- read-only." />
          <ReportStatusBadge status="SENT" />
        </div>

        {manualSend && (
          <AlertPanel tone="info" className="mt-4">
            <p className="text-sm text-[var(--color-ink)]">
              Marked as sent manually by {manualSend.sentBy ?? 'someone'} -- it was sent outside the dashboard, so no email went out from here. The
              baseline was saved from <span className="font-semibold">{manualSend.sourceFilename ?? 'the uploaded file'}</span>.
            </p>
          </AlertPanel>
        )}

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

        {!manualSend && report.client?.consolidatedReport && report.attachmentSource === 'generated' ? (
          <AlertPanel tone="info" className="mt-4">
            <p className="text-sm text-[var(--color-ink)]">
              The consolidated Excel was sent instead of the PDF. The latest one sent is kept as this client's history --{' '}
              <a href={getConsolidatedHistoryFileUrl(report.clientId)} className="font-medium text-brand-300 hover:text-brand-200">
                download it
              </a>
              .
            </p>
          </AlertPanel>
        ) : !manualSend && (
          <div className="mt-4">
            <p className="eyebrow-label mb-2">Attached report (PDF)</p>
            <ReportPdfPreview reportId={report.id} />
          </div>
        )}
      </AppShell>
    );
  }

  const recipients = report.resolvedRecipients ?? [];
  const cc = report.resolvedCc ?? [];
  // Blocked only because an older email in the task has the same subject -- offer "Send anyway".
  const duplicateSubjectBlocked = DUPLICATE_SUBJECT_BLOCK.test(error ?? (report.status === 'APPROVED' ? (report.lastErrorMessage ?? '') : ''));

  function handleSendAnyway() {
    if (
      !window.confirm(
        'Open the ClickUp task and check: has THIS report already been emailed?\n\nOnly click OK if the email with this subject is an older report (e.g. last period). OK sends it now.',
      )
    )
      return;
    void handleApproveAndSend(true);
  }

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
            <span className="text-[var(--color-ink-faint)]">Cc</span>
            <span className="text-right text-[var(--color-ink)]">{cc.length > 0 ? cc.join(', ') : '(none)'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Subject</span>
            <span className="text-right text-[var(--color-ink)]">{report.emailSubject ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Report</span>
            <span className="text-right text-[var(--color-ink)]">Ranking report #{report.id.slice(0, 8)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--color-ink-faint)]">Attachments</span>
            <span className="text-right text-[var(--color-ink)]">
              {[
                ...(report.attachmentSource === 'none'
                  ? []
                  : [
                      report.attachmentSource === 'custom' && report.customPdfFilename
                        ? report.customPdfFilename
                        : report.client?.consolidatedReport
                          ? 'Consolidated ranking report (Excel)'
                          : 'Ranking report PDF',
                    ]),
                ...(report.extraAttachments ?? []).map((a) => a.filename),
              ].join(', ') || 'None'}
            </span>
          </div>
        </div>

        {report.client?.consolidatedReport && report.attachmentSource === 'generated' && <ConsolidatedReportInfo reportId={report.id} clientId={report.clientId} editable={!sending} className="mt-5" />}

        {GA_PLACEHOLDER.test(report.emailBody ?? '') && (
          <AlertPanel tone="warning" className="mt-5">
            <p className="text-sm text-amber-300">
              The email still has unfilled placeholders: {[...new Set((report.emailBody ?? '').match(GA_PLACEHOLDER_ALL) ?? [])].join(', ')}. Go back to the Email Draft and replace them first.
            </p>
          </AlertPanel>
        )}

        <div className="mt-5">
          <p className="eyebrow-label mb-1.5">Body</p>
          <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{report.emailBody ?? '—'}</p>
        </div>

        <div className="mt-5">
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Approved by</label>
          <p className="text-sm text-[var(--color-ink)]">{user?.name ?? user?.email ?? '—'}</p>
        </div>

        <AlertPanel tone="warning" className="mt-5 flex items-start gap-2.5">
          <p className="text-sm text-amber-300">This report will be emailed and marked Sent. This cannot be undone.</p>
        </AlertPanel>

        {/* Why the last send didn't finish (e.g. the server restarted mid-send) -- it was stored but never shown. */}
        {!error && report.status === 'APPROVED' && report.lastErrorMessage && (
          <AlertPanel tone="warning" className="mt-4">
            <p className="text-sm text-amber-300">Last send attempt: {report.lastErrorMessage}</p>
          </AlertPanel>
        )}

        <InlineError message={error} className="mt-4" />

        {duplicateSubjectBlocked && (
          <AlertPanel tone="warning" className="mt-4">
            <p className="text-sm text-amber-300">
              The ClickUp task already has an email with this same subject. If that one is an older report (some clients get the same subject every
              time), check the task and use <strong>Send anyway</strong>.
            </p>
            {report.resolvedClickupTaskUrl && (
              <a href={report.resolvedClickupTaskUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-brand-300 hover:text-brand-200">
                Open the ClickUp task
              </a>
            )}
          </AlertPanel>
        )}

        <div className="mt-6 flex items-center gap-3">
          <Button disabled={sending || recipients.length === 0} onClick={() => void handleApproveAndSend()}>
            {sending && <Spinner />}
            Approve &amp; Send
          </Button>
          {duplicateSubjectBlocked && (
            <Button variant="secondary" disabled={sending || recipients.length === 0} onClick={handleSendAnyway}>
              Send anyway
            </Button>
          )}
          <Link to={`/reports/${reportId}/email`}>
            <Button variant="ghost">Cancel</Button>
          </Link>
        </div>

        <div className="mt-6 border-t border-[var(--color-border)] pt-4">
          <p className="text-sm text-[var(--color-ink-muted)]">
            Already sent this report to the client outside the dashboard (from ClickUp, or your own report)? Mark it as sent and upload the report you
            sent, so the next report compares with it.
          </p>
          <Button variant="secondary" className="mt-3" disabled={sending} onClick={() => setMarkingManually(true)}>
            Mark as sent manually
          </Button>
        </div>
      </Card>

      <MarkSentManuallyModal
        open={markingManually}
        reportId={report.id}
        defaultSentDate={localDateInput(report.reportDate)}
        onClose={() => setMarkingManually(false)}
        onMarked={() => {
          setMarkingManually(false);
          void getReport(report.id).then(setReport);
          setSent(true);
        }}
      />
    </AppShell>
  );
}
