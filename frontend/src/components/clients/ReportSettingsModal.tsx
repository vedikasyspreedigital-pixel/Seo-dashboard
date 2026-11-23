import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { InlineError } from '../ui/InlineError';
import { AlertPanel } from '../ui/AlertPanel';
import { CheckCircleIcon, DocumentIcon, GridIcon, ClockIcon, UploadDropIcon } from '../ui/icons';
import { getConsolidatedHistoryFileUrl, getConsolidatedSettings, setClientReportType, uploadConsolidatedHistory } from '../../api/client';
import type { ConsolidatedSettings, ReportType } from '../../api/types';

interface Props {
  clientId: string;
  clientName: string;
  onClose: () => void;
  /** The report type or history changed -- refresh the client list. */
  onChanged: () => void;
}

const ACCEPTED = { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] };

const OPTIONS: { value: ReportType; title: string; detail: string; Icon: typeof DocumentIcon }[] = [
  { value: 'normal', title: 'Normal report', detail: 'The 2-date PDF: previous vs current ranks.', Icon: DocumentIcon },
  { value: 'consolidated', title: 'Consolidated Excel', detail: 'One Excel with every past date as a column, newest first.', Icon: GridIcon },
  { value: 'unconfirmed', title: 'Not confirmed yet', detail: "You'll get a notification each time this client's run finishes until it's set.", Icon: ClockIcon },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Report settings (2026-11-23): which report this client gets -- the normal 2-date PDF, the consolidated Excel
 * (every past date as a column), or "not confirmed yet" -- and, for consolidated clients, the stored history
 * (the client's last consolidated Excel; each sent report replaces it).
 */
export function ReportSettingsModal({ clientId, clientName, onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<ConsolidatedSettings | null>(null);
  const [busy, setBusy] = useState<ReportType | 'upload' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);

  useEffect(() => {
    getConsolidatedSettings(clientId)
      .then(setSettings)
      .catch((err: Error) => setError(err.message));
  }, [clientId]);

  async function choose(type: ReportType) {
    if (!settings || settings.reportType === type || busy) return;
    setBusy(type);
    setError(null);
    try {
      setSettings(await setClientReportType(clientId, type));
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
        setSettings((s) => ({ ...result, reportType: s?.reportType ?? result.reportType }));
        setUploaded(`Saved. The newest date in the file is ${result.newestLabel}.`);
        onChanged();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [clientId, settings, onChanged],
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled: busy !== null });

  const history = settings?.history ?? null;
  const type = settings?.reportType;

  return (
    <Modal
      open
      onClose={() => busy === null && onClose()}
      title={`Report settings · ${clientName}`}
      footer={
        <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
          Done
        </Button>
      }
    >
      {!settings ? (
        error ? <InlineError message={error} /> : <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className="space-y-6">
          <section>
            <p className="eyebrow-label mb-3">Report type</p>
            <div role="radiogroup" aria-label="Report type" className="flex flex-col gap-2">
              {OPTIONS.map(({ value, title, detail, Icon }) => {
                const selected = type === value;
                const warn = value === 'unconfirmed';
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy !== null}
                    onClick={() => void choose(value)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-wait ${
                      selected
                        ? warn
                          ? 'border-amber-400/60 bg-amber-500/[0.08]'
                          : 'border-brand-400/70 bg-brand-400/[0.08]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]'
                    }`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? (warn ? 'bg-amber-400/15 text-amber-300' : 'bg-brand-400/15 text-brand-300') : 'bg-overlay/[0.05] text-[var(--color-ink-muted)]'}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[var(--color-ink)]">{title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-ink-faint)]">{detail}</span>
                    </span>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {busy === value ? <Spinner /> : selected && <CheckCircleIcon className={`h-5 w-5 ${warn ? 'text-amber-300' : 'text-brand-300'}`} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {type === 'consolidated' && (
            <section>
              <p className="eyebrow-label mb-3">Consolidated history</p>
              <p className="mb-3 text-sm text-[var(--color-ink-muted)]">
                The client's last consolidated Excel, stored here. Each report adds its date in front of it (your layout and colours stay), and once
                the report is sent, that file becomes the new history.
              </p>
              {history ? (
                <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--color-ink)]" title={history.filename}>
                      {history.filename}
                    </p>
                    <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                      Up to {formatDate(history.newestDate)} · {history.dateColumns} date columns · {history.keywordCount} keywords ·{' '}
                      {history.source === 'sent' ? 'last sent from the dashboard' : `uploaded by ${history.updatedBy ?? 'someone'}`} on {formatDate(history.updatedAt)}
                    </p>
                  </div>
                  <a href={getConsolidatedHistoryFileUrl(clientId)} className="shrink-0 text-xs font-semibold text-brand-300 hover:text-brand-200">
                    Download
                  </a>
                </div>
              ) : (
                <AlertPanel tone="warning">
                  <p className="text-sm text-amber-300">No history yet. Upload the last consolidated Excel this client received. Reports can't be sent until it's here.</p>
                </AlertPanel>
              )}

              <div
                {...getRootProps()}
                className={`mt-3 cursor-pointer rounded-xl border-2 border-dashed px-6 py-5 text-center transition-colors ${
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
              {uploaded && <p className="mt-3 text-sm text-emerald-300">{uploaded}</p>}
            </section>
          )}

          <InlineError message={error} />
        </div>
      )}
    </Modal>
  );
}
