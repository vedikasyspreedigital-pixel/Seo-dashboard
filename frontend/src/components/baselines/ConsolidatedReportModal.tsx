import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { InlineError } from '../ui/InlineError';
import { AlertPanel } from '../ui/AlertPanel';
import { UploadDropIcon } from '../ui/icons';
import { getConsolidatedHistoryFileUrl, getConsolidatedSettings, setConsolidatedEnabled, uploadConsolidatedHistory } from '../../api/client';
import type { ConsolidatedSettings } from '../../api/types';

interface Props {
  clientId: string;
  clientName: string;
  onClose: () => void;
  /** The switch changed -- refresh the client list's badge. */
  onChanged: () => void;
}

const ACCEPTED = { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * "Consolidated report" (2026-11-10): some clients get ONE Excel with every past ranking date as a column
 * instead of the 2-date PDF. Here the team switches it on and uploads the client's last consolidated Excel;
 * each report then adds its date column in front of that file, and the sent file becomes the new history.
 */
export function ConsolidatedReportModal({ clientId, clientName, onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<ConsolidatedSettings | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'upload' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);

  useEffect(() => {
    getConsolidatedSettings(clientId)
      .then(setSettings)
      .catch((err: Error) => setError(err.message));
  }, [clientId]);

  async function toggle(enabled: boolean) {
    setBusy('toggle');
    setError(null);
    try {
      setSettings(await setConsolidatedEnabled(clientId, enabled));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      if (settings?.history && !window.confirm(`Replace the saved history (${settings.history.filename}) with ${file.name}?`)) return;
      setBusy('upload');
      setError(null);
      setUploaded(null);
      try {
        const result = await uploadConsolidatedHistory(clientId, file);
        setSettings(result);
        setUploaded(`Saved -- newest date in the file: ${result.newestLabel}.`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [clientId, settings],
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled: busy !== null });

  const history = settings?.history ?? null;

  return (
    <Modal open onClose={() => busy === null && onClose()} title={`Consolidated report -- ${clientName}`}>
      {!settings ? (
        error ? <InlineError message={error} /> : <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-[var(--color-ink-muted)]">
            The client gets <span className="text-[var(--color-ink)]">one Excel with every past ranking date as a column</span> (newest first) instead of
            the 2-date PDF. Each report adds its date in front of the client's last consolidated file and keeps your layout and colours.
          </p>

          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand,#6366f1)]" checked={settings.enabled} disabled={busy !== null} onChange={(e) => void toggle(e.target.checked)} />
            <span className="text-sm font-medium text-[var(--color-ink)]">Send the consolidated report instead of the PDF</span>
            {busy === 'toggle' && <Spinner />}
          </label>

          <div>
            <p className="eyebrow-label mb-2">History (the client's last consolidated Excel)</p>
            {history ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
                <p className="truncate text-[var(--color-ink)]" title={history.filename}>
                  {history.filename}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                  Up to {formatDate(history.newestDate)} &middot; {history.dateColumns} date columns &middot; {history.keywordCount} keywords &middot;{' '}
                  {history.source === 'sent' ? 'last sent from the dashboard' : `uploaded by ${history.updatedBy ?? 'someone'}`} on {formatDate(history.updatedAt)}
                </p>
                <a href={getConsolidatedHistoryFileUrl(clientId)} className="mt-2 inline-block text-xs font-medium text-brand-300 hover:text-brand-200">
                  Download
                </a>
              </div>
            ) : (
              <AlertPanel tone="warning">
                <p className="text-sm text-amber-300">No history yet. Upload the last consolidated Excel this client received -- reports can't be sent until it's here.</p>
              </AlertPanel>
            )}
          </div>

          <div
            {...getRootProps()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-6 text-center transition-colors ${
              isDragActive ? 'border-brand-400 bg-brand-400/[0.06]' : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50'
            } ${busy !== null ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input {...getInputProps()} />
            {busy === 'upload' ? (
              <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-ink-muted)]">
                <Spinner /> Reading the file...
              </div>
            ) : (
              <>
                <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
                  <UploadDropIcon className="h-4 w-4" />
                </div>
                <p className="text-sm font-semibold text-[var(--color-ink)]">{history ? 'Replace with another consolidated Excel' : 'Upload the last consolidated Excel'}</p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">.xlsx with a "Keyword" column and one column per date</p>
              </>
            )}
          </div>

          {uploaded && <p className="text-sm text-emerald-300">{uploaded}</p>}
          <InlineError message={error} />

          <div className="flex justify-end">
            <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
