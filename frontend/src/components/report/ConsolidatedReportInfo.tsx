import { useEffect, useRef, useState } from 'react';
import { AlertPanel } from '../ui/AlertPanel';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { UploadIcon } from '../ui/icons';
import { getReportConsolidatedInfo, getReportConsolidatedUrl, uploadConsolidatedHistory } from '../../api/client';
import type { ReportConsolidatedInfo } from '../../api/types';

/**
 * For a consolidated client (2026-11-10): what this report's consolidated Excel will contain -- the new date
 * column, keywords new to it or left out -- with a download, or why it can't be built yet (no history uploaded).
 * While the report can still be changed, the team uploads the client's last consolidated Excel right here;
 * the dashboard adds this report's column to it.
 */
export function ConsolidatedReportInfo({ reportId, clientId, editable, className = '' }: { reportId: string; clientId: string; editable: boolean; className?: string }) {
  const [info, setInfo] = useState<ReportConsolidatedInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInfo(null);
    setError(null);
    getReportConsolidatedInfo(reportId)
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [reportId, attempt]);

  async function handleFile(list: FileList | null) {
    const file = list?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadConsolidatedHistory(clientId, file);
      setAttempt((n) => n + 1);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const uploadButton = (label: string) =>
    editable && (
      <div className="mt-3">
        <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => void handleFile(e.target.files)} />
        <Button variant="secondary" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? <Spinner /> : <UploadIcon className="h-4 w-4" />}
          {label}
        </Button>
        {uploadError && <p className="mt-2 text-sm text-rose-300">{uploadError}</p>}
      </div>
    );

  if (error) return <p className={`text-sm text-rose-300 ${className}`}>Couldn't check the consolidated report: {error}</p>;
  if (!info) {
    return (
      <div className={`flex items-center gap-2 text-sm text-[var(--color-ink-muted)] ${className}`}>
        <Spinner /> Building the consolidated report...
      </div>
    );
  }
  if (!info.enabled) return null;
  if (!info.ready) {
    return (
      <AlertPanel tone="warning" className={className}>
        <p className="text-sm text-amber-300">{info.error}</p>
        {editable && (
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            Upload the last consolidated Excel this client received -- the dashboard adds this report's date column in front of it.
          </p>
        )}
        {uploadButton('Upload consolidated Excel')}
      </AlertPanel>
    );
  }
  return (
    <AlertPanel tone="info" className={className}>
      <p className="text-sm text-[var(--color-ink)]">
        This client gets the <span className="font-semibold">consolidated Excel</span> instead of the PDF: the new <span className="font-semibold">{info.newColumnLabel}</span>{' '}
        column in front of {info.dateColumns - 1} older date{info.dateColumns - 1 === 1 ? '' : 's'}, {info.keywordCount} keywords.{' '}
        <a href={getReportConsolidatedUrl(reportId)} className="font-medium text-brand-300 hover:text-brand-200">
          Download to check
        </a>
      </p>
      {info.added.length > 0 && <p className="mt-2 text-xs text-[var(--color-ink-muted)]">New keywords (no history yet, older columns empty): {info.added.join(', ')}</p>}
      {info.dropped.length > 0 && <p className="mt-2 text-xs text-amber-300">Not in this run, so left out of the report: {info.dropped.join(', ')}</p>}
      {uploadButton('Use a different consolidated Excel')}
    </AlertPanel>
  );
}
