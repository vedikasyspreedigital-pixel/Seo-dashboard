import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { InlineError } from '../ui/InlineError';
import { UploadDropIcon } from '../ui/icons';
import { uploadVerifiedExcel } from '../../api/client';
import type { RankingReport } from '../../api/types';

interface Props {
  open: boolean;
  runId: string;
  onClose: () => void;
  /** Called once the verified Excel has been fully processed (compared, PDF built, email drafted). */
  onProcessed: (report: RankingReport) => void;
}

const ACCEPTED = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

/**
 * The new workflow's one upload step -- no preview/confirm here (unlike
 * BaselineUploadModal): dropping the file immediately kicks off the backend's
 * automatic compare -> build PDF -> draft email pipeline
 * (processVerifiedExcelUpload.ts), so this only ever shows a drop target or a
 * progress state, never a review table.
 */
export function VerifiedExcelUploadModal({ open, runId, onClose, onProcessed }: Props) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    if (processing) return; // don't let the modal be dismissed mid-upload
    setError(null);
    onClose();
  }

  const handleFileSelected = useCallback(
    async (file: File) => {
      setProcessing(true);
      setError(null);
      try {
        const result = await uploadVerifiedExcel(runId, file);
        if (result.outcome === 'CREATED' && result.report) {
          onProcessed(result.report);
          return;
        }
        if (result.outcome === 'DUPLICATE') {
          setError('A report has already been generated for this run.');
        } else if (result.outcome === 'UNMATCHED_ROWS') {
          setError(
            `This file doesn't match this run's exported Excel${result.unmatchedKeywords?.length ? ` (unrecognized: ${result.unmatchedKeywords.slice(0, 3).join(', ')}${result.unmatchedKeywords.length > 3 ? '...' : ''})` : ''}. Upload the Excel downloaded from this run, with your corrections applied.`,
          );
        } else {
          setError(result.message ?? 'Could not process this file.');
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setProcessing(false);
      }
    },
    [runId, onProcessed],
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) void handleFileSelected(accepted[0]);
    },
    [handleFileSelected],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled: processing });

  return (
    <Modal open={open} onClose={handleClose} title="Upload Verified Excel">
      <p className="mb-4 text-sm text-[var(--color-ink-muted)]">
        Upload the ranking Excel after your manual verification. The backend will automatically compare it against
        the previous verified Excel, generate the report PDF, and draft the client email -- no additional steps
        needed.
      </p>
      <div
        {...getRootProps()}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          isDragActive
            ? 'border-brand-400 bg-brand-400/[0.06]'
            : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50 hover:bg-brand-400/[0.03]'
        } ${processing ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input {...getInputProps()} />
        {processing ? (
          <div className="flex flex-col items-center justify-center gap-2 text-[var(--color-ink-muted)]">
            <Spinner className="h-4 w-4" />
            <span className="text-sm font-medium">Uploading...</span>
            <span className="text-xs text-[var(--color-ink-faint)]">Comparing with previous verified report...</span>
            <span className="text-xs text-[var(--color-ink-faint)]">Generating report...</span>
          </div>
        ) : (
          <div>
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
              <UploadDropIcon className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">
              {isDragActive ? 'Drop the file here' : 'Drop the verified ranking Excel here'}
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">or click to browse &middot; .xlsx</p>
          </div>
        )}
      </div>

      {error && <InlineError message={error} className="mt-3" />}
    </Modal>
  );
}
