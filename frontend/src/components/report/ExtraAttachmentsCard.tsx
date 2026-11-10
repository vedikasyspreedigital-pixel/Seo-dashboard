import { useRef, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { DocumentIcon, EyeIcon, TrashIcon, UploadIcon } from '../ui/icons';
import {
  getCustomPdfUrl,
  getExtraAttachmentUrl,
  getReport,
  getReportBaselineUrl,
  getReportConsolidatedUrl,
  getReportPdfUrl,
  removeExtraAttachment,
  setConsolidatedEnabled,
  updateReportDraft,
  uploadExtraAttachments,
} from '../../api/client';
import type { RankingReport } from '../../api/types';
import { AttachmentViewerModal, type ViewedAttachment } from './AttachmentViewerModal';
import { ConsolidatedReportInfo } from './ConsolidatedReportInfo';
import { BaselineReportInfo } from './BaselineReportInfo';

const MAX_FILES = 5;
const ACCEPTED = 'application/pdf,.pdf,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

// Opens the attached file in the viewer on this same page.
function ViewButton({ filename, onView }: { filename: string; onView: () => void }) {
  return (
    <button
      type="button"
      title={`View ${filename}`}
      aria-label={`View ${filename}`}
      onClick={onView}
      className="shrink-0 rounded-full p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-brand-500/10 hover:text-brand-300"
    >
      <EyeIcon className="h-4 w-4" />
    </button>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Everything attached to the email: the report PDF plus any extra PDF/Excel
 * files uploaded here, e.g. the client's Google Analytics reports. They are all
 * sent together. The report PDF can be left off (attachmentSource "none") so
 * only the uploaded files go out. Editable only while the report awaits approval.
 */
export function ExtraAttachmentsCard({ report, editable, onChange }: { report: RankingReport; editable: boolean; onChange: (updated: RankingReport) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewedAttachment | null>(null);
  const extras = report.extraAttachments ?? [];
  const reportPdfOff = report.attachmentSource === 'none';
  // Consolidated client: the generated attachment is the consolidated Excel, not the PDF (a custom PDF still wins).
  const consolidated = !!report.client?.consolidatedReport && report.attachmentSource === 'generated';
  const baseline = report.attachmentSource === 'baseline';
  const reportPdfLabel = baseline
    ? `${report.client?.name ?? 'Client'} - Baseline Report.xlsx (generated)`
    : report.attachmentSource === 'custom' && report.customPdfFilename
      ? `${report.customPdfFilename} (custom report PDF)`
      : report.client?.consolidatedReport
        ? `${report.client.name} - Consolidated Keyword Ranking Report.xlsx (generated)`
        : 'Ranking report PDF (generated)';

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;
    setError(null);
    setBusy('upload');
    try {
      onChange(await uploadExtraAttachments(report.id, files));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(id: string, filename: string) {
    if (!window.confirm(`Remove "${filename}" from this email?`)) return;
    setError(null);
    setBusy(id);
    try {
      onChange(await removeExtraAttachment(report.id, id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Leaving the report PDF off only changes what is attached -- the PDF itself is kept and can be attached again.
  async function setReportPdf(attach: boolean) {
    if (!attach && !window.confirm('Send this email without the dashboard report PDF? Only the files you added will be attached.')) return;
    setError(null);
    setBusy('report-pdf');
    try {
      onChange(await updateReportDraft(report.id, { attachmentSource: attach ? 'generated' : 'none' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Baseline Report: this report only (a new client's first report) -- picked by the team.
  async function setBaseline(on: boolean) {
    const question = on
      ? 'Send this report as the Baseline Report (new client) instead of the PDF?\n\nIt is an Excel with search volume, competition, number of results, SERP result, intent and the ranks. Upload the Keyword Planner download for the volumes next.'
      : 'Send the normal report instead of the Baseline Report?';
    if (!window.confirm(question)) return;
    setError(null);
    setBusy('baseline');
    try {
      onChange(await updateReportDraft(report.id, { attachmentSource: on ? 'baseline' : 'generated' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // A client setting, not just this report: every later report of the client follows it too.
  async function switchConsolidated(enabled: boolean) {
    const name = report.client?.name ?? 'this client';
    const question = enabled
      ? `Send ${name} the consolidated Excel instead of the PDF -- this report and every later one?\n\nYou'll then upload the last consolidated Excel they received; the dashboard adds this report's date column to it.`
      : `Go back to the normal PDF report for ${name} -- this report and every later one?`;
    if (!window.confirm(question)) return;
    setError(null);
    setBusy('consolidated');
    try {
      await setConsolidatedEnabled(report.clientId, enabled);
      onChange(await getReport(report.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow-label">Attachments</p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">All of these are attached to the email together.</p>
        </div>
        {editable && (
          <>
            <input ref={inputRef} type="file" accept={ACCEPTED} multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
            <Button variant="secondary" disabled={busy !== null || extras.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>
              {busy === 'upload' ? <Spinner /> : <UploadIcon className="h-4 w-4" />}
              Add PDF / Excel
            </Button>
          </>
        )}
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        <li
          className={`flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm ${reportPdfOff ? 'opacity-60' : ''}`}
        >
          <DocumentIcon className="h-4 w-4 shrink-0 text-brand-300" />
          <span className={`truncate text-[var(--color-ink)] ${reportPdfOff ? 'line-through' : ''}`}>{reportPdfLabel}</span>
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-[var(--color-ink-faint)]">{reportPdfOff ? 'not attached' : 'attached'}</span>
          {report.attachmentSource === 'custom' && report.customPdfFilename ? (
            <ViewButton filename={report.customPdfFilename} onView={() => setViewing({ filename: report.customPdfFilename!, url: getCustomPdfUrl(report.id) })} />
          ) : baseline ? (
            <a
              href={getReportBaselineUrl(report.id)}
              title="Download the Baseline Report"
              aria-label="Download the Baseline Report"
              className="shrink-0 rounded-full p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-brand-500/10 hover:text-brand-300"
            >
              <EyeIcon className="h-4 w-4" />
            </a>
          ) : report.client?.consolidatedReport ? (
            <a
              href={getReportConsolidatedUrl(report.id)}
              title="Download the consolidated report"
              aria-label="Download the consolidated report"
              className="shrink-0 rounded-full p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-brand-500/10 hover:text-brand-300"
            >
              <EyeIcon className="h-4 w-4" />
            </a>
          ) : (
            report.clientPdfPath && <ViewButton filename="the report PDF" onView={() => setViewing({ filename: 'Ranking report.pdf', url: getReportPdfUrl(report.id) })} />
          )}
          {editable &&
            (reportPdfOff ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void setReportPdf(true)}
                className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium text-brand-300 transition-colors hover:bg-brand-500/10 disabled:opacity-50"
              >
                {busy === 'report-pdf' ? <Spinner /> : 'Attach again'}
              </button>
            ) : (
              <button
                type="button"
                title="Don't attach the report PDF"
                aria-label="Don't attach the report PDF"
                disabled={busy !== null}
                onClick={() => void setReportPdf(false)}
                className="rounded-full p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50"
              >
                {busy === 'report-pdf' ? <Spinner /> : <TrashIcon className="h-4 w-4" />}
              </button>
            ))}
        </li>
        {extras.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
            <DocumentIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)]" />
            <span className="truncate text-[var(--color-ink)]" title={a.filename}>
              {a.filename}
            </span>
            <span className="ml-auto shrink-0 text-xs text-[var(--color-ink-faint)]">{formatSize(a.size)}</span>
            <ViewButton filename={a.filename} onView={() => setViewing({ filename: a.filename, url: getExtraAttachmentUrl(report.id, a.id), reportId: report.id, attachmentId: a.id })} />
            {editable && (
              <button
                type="button"
                title={`Remove ${a.filename}`}
                aria-label={`Remove ${a.filename}`}
                disabled={busy !== null}
                onClick={() => void handleRemove(a.id, a.filename)}
                className="rounded-full p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50"
              >
                {busy === a.id ? <Spinner /> : <TrashIcon className="h-4 w-4" />}
              </button>
            )}
          </li>
        ))}
      </ul>

      {baseline && <BaselineReportInfo reportId={report.id} editable={editable} className="mt-3" />}

      {consolidated && <ConsolidatedReportInfo reportId={report.id} clientId={report.clientId} editable={editable} className="mt-3" />}

      {editable && report.client && report.attachmentSource === 'generated' && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void switchConsolidated(!report.client!.consolidatedReport)}
          className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-brand-300 hover:text-brand-200 disabled:opacity-50"
        >
          {busy === 'consolidated' && <Spinner />}
          {report.client.consolidatedReport ? 'Send the PDF instead (switch this client back to the normal report)' : 'Send the consolidated Excel instead of the PDF (every past date as a column)'}
        </button>
      )}

      {editable && (report.attachmentSource === 'generated' || baseline) && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void setBaseline(!baseline)}
          className="mt-3 flex items-center gap-2 text-xs font-medium text-brand-300 hover:text-brand-200 disabled:opacity-50"
        >
          {busy === 'baseline' && <Spinner />}
          {baseline ? 'Send the normal report instead of the Baseline Report' : 'Send the Baseline Report instead (new client: volume, competition, SERP result, intent)'}
        </button>
      )}

      {editable && extras.length === 0 && (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Add extra PDF or Excel files here, e.g. the Google Analytics Traffic Acquisition and Engagement Overview reports (up to {MAX_FILES}, 15 MB each).
        </p>
      )}
      {reportPdfOff && extras.length === 0 && <p className="mt-3 text-sm text-amber-300">Nothing will be attached. Add a file, or attach the report PDF again, before sending.</p>}
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      <AttachmentViewerModal attachment={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}
