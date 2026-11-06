import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { InlineError } from '../ui/InlineError';
import { AlertPanel } from '../ui/AlertPanel';
import { UploadDropIcon } from '../ui/icons';
import { markReportSentManually, previewSentReport } from '../../api/client';
import type { SentReportPreview } from '../../api/types';

interface Props {
  open: boolean;
  reportId: string;
  /** Pre-fills the sent date (the report's date), as yyyy-mm-dd. */
  defaultSentDate: string;
  onClose: () => void;
  onMarked: () => void;
}

const ACCEPTED = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/pdf': ['.pdf'],
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatRank(row: SentReportPreview['rows'][number]): string {
  return row.rankDisplay ?? (row.rankValue !== null ? String(row.rankValue) : '—');
}

/**
 * "Mark as sent manually": the report went to the client outside the dashboard (sent by hand from
 * ClickUp, or the team's own report instead of the generated one). The team uploads the file the
 * client actually got; its ranks become the baseline the next report compares with. No email is sent.
 */
export function MarkSentManuallyModal({ open, reportId, defaultSentDate, onClose, onMarked }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SentReportPreview | null>(null);
  const [sentDate, setSentDate] = useState(defaultSentDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
  }

  function handleClose() {
    if (saving) return;
    reset();
    setSentDate(defaultSentDate);
    onClose();
  }

  const handleFileSelected = useCallback(
    async (selected: File) => {
      setFile(selected);
      setPreview(null);
      setError(null);
      setPreviewing(true);
      try {
        setPreview(await previewSentReport(reportId, selected));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPreviewing(false);
      }
    },
    [reportId],
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) void handleFileSelected(accepted[0]);
    },
    [handleFileSelected],
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled: previewing });

  const wrongFile = !!preview && preview.totalKeywords > 0 && preview.matchedKeywords / preview.totalKeywords < preview.minMatch;
  const sentDateValid = /^\d{4}-\d{2}-\d{2}$/.test(sentDate) && sentDate <= todayIso();

  async function handleConfirm() {
    if (!preview || wrongFile || !sentDateValid) return;
    setSaving(true);
    setError(null);
    try {
      // Midday local time, so the date can't slip to the day before/after in another time zone.
      await markReportSentManually(reportId, preview, new Date(`${sentDate}T12:00:00`).toISOString());
      reset();
      onMarked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Mark as sent manually"
      footer={
        preview ? (
          <>
            <Button variant="ghost" disabled={saving} onClick={reset}>
              Choose a different file
            </Button>
            <Button disabled={saving || wrongFile || !sentDateValid} onClick={handleConfirm}>
              {saving && <Spinner />}
              Mark as sent &amp; save baseline
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-ink-muted)]">
          Use this when the report was sent to the client <span className="text-[var(--color-ink)]">outside the dashboard</span> (from ClickUp, or your own
          report instead of the generated one). <span className="font-semibold text-[var(--color-ink)]">No email is sent from here.</span>
        </p>

        <div>
          <label htmlFor="manual-sent-date" className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">
            Date it was sent
          </label>
          <input
            id="manual-sent-date"
            type="date"
            value={sentDate}
            max={todayIso()}
            disabled={saving}
            onChange={(e) => setSentDate(e.target.value)}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
        </div>

        {!preview && (
          <div>
            <p className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Now upload the report that was sent to the client</p>
            <p className="mb-3 text-xs text-[var(--color-ink-faint)]">
              Its ranks are saved as this client's baseline, so the next report compares with exactly what the client received. Upload the Excel if you
              have it; a PDF works too.
            </p>
            <div
              {...getRootProps()}
              className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
                isDragActive
                  ? 'border-brand-400 bg-brand-400/[0.06]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50 hover:bg-brand-400/[0.03]'
              } ${previewing ? 'pointer-events-none opacity-60' : ''}`}
            >
              <input {...getInputProps()} />
              {previewing ? (
                <div className="flex items-center justify-center gap-2.5 text-[var(--color-ink-muted)]">
                  <Spinner className="h-4 w-4" />
                  <span className="text-sm font-medium">Reading {file?.name}...</span>
                </div>
              ) : (
                <div>
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
                    <UploadDropIcon className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{isDragActive ? 'Drop the file here' : 'Drop the sent report here'}</p>
                  <p className="mt-1 text-xs text-[var(--color-ink-faint)]">or click to browse &middot; .xlsx or .pdf</p>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <InlineError message={error} />}

        {preview && (
          <div>
            <p className="text-sm text-[var(--color-ink)]">
              Baseline date: <span className="font-semibold text-brand-300">{preview.baselineDateLabel}</span>
              {preview.detectedDates.length > 1 && <> (the newest of {preview.detectedDates.length} dates in the file)</>}
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
              {preview.rows.length} keyword{preview.rows.length === 1 ? '' : 's'} read from {preview.sourceFilename} &middot; {preview.matchedKeywords} of this
              report's {preview.totalKeywords} keywords found
            </p>
            {wrongFile && (
              <AlertPanel tone="warning" className="mt-3">
                <p className="text-sm text-amber-300">
                  Only {preview.matchedKeywords} of {preview.totalKeywords} keywords match this report -- this looks like another client's or an older report.
                  Choose the report that was actually sent.
                </p>
              </AlertPanel>
            )}
            {!sentDateValid && <InlineError message="Pick the date it was sent (not in the future)." className="mt-3" />}
            <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-[var(--color-surface-2)]">
                  <tr className="border-b border-[var(--color-border)] eyebrow-label">
                    <th className="cell-compact">Keyword</th>
                    <th className="cell-compact">Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                      <td className="cell-compact text-[var(--color-ink)]">{row.keyword}</td>
                      <td className="cell-compact font-mono text-[var(--color-ink-muted)]">{formatRank(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
