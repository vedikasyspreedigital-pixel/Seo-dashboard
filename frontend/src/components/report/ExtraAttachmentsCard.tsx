import { useRef, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { DocumentIcon, TrashIcon, UploadIcon } from '../ui/icons';
import { removeExtraAttachment, uploadExtraAttachments } from '../../api/client';
import type { RankingReport } from '../../api/types';

const MAX_FILES = 5;

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Everything attached to the email: the report PDF (always) plus any extra
 * PDFs uploaded here, e.g. the client's Google Analytics reports. They are all
 * sent together. Editable only while the report awaits approval.
 */
export function ExtraAttachmentsCard({ report, editable, onChange }: { report: RankingReport; editable: boolean; onChange: (updated: RankingReport) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const extras = report.extraAttachments ?? [];
  const reportPdfLabel = report.attachmentSource === 'custom' && report.customPdfFilename ? `${report.customPdfFilename} (custom report PDF)` : 'Ranking report PDF (generated)';

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

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow-label">Attachments</p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">All of these are attached to the email together.</p>
        </div>
        {editable && (
          <>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
            <Button variant="secondary" disabled={busy !== null || extras.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>
              {busy === 'upload' ? <Spinner /> : <UploadIcon className="h-4 w-4" />}
              Add PDF
            </Button>
          </>
        )}
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        <li className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
          <DocumentIcon className="h-4 w-4 shrink-0 text-brand-300" />
          <span className="truncate text-[var(--color-ink)]">{reportPdfLabel}</span>
          <span className="ml-auto text-xs text-[var(--color-ink-faint)]">always attached</span>
        </li>
        {extras.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
            <DocumentIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)]" />
            <span className="truncate text-[var(--color-ink)]" title={a.filename}>
              {a.filename}
            </span>
            <span className="ml-auto shrink-0 text-xs text-[var(--color-ink-faint)]">{formatSize(a.size)}</span>
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

      {editable && extras.length === 0 && (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">Add extra PDFs here, e.g. the Google Analytics Traffic Acquisition and Engagement Overview reports (up to {MAX_FILES}, 15 MB each).</p>
      )}
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
    </Card>
  );
}
