import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { InlineError } from '../ui/InlineError';
import { UploadDropIcon } from '../ui/icons';
import { previewBaseline, confirmBaseline } from '../../api/client';
import type { BaselinePreview } from '../../api/types';

interface Props {
  open: boolean;
  clientId: string;
  onClose: () => void;
  /** Called once a baseline is successfully stored, so the caller can refresh whatever list/badge shows a client's baseline history. */
  onConfirmed: () => void;
}

const ACCEPTED = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/pdf': ['.pdf'],
};

function formatRank(row: BaselinePreview['rows'][number]): string {
  return row.rankDisplay ?? (row.rankValue !== null ? String(row.rankValue) : '—');
}

/**
 * Upload -> preview -> confirm, per the explicit requirement: extraction is
 * always shown before anything is stored, and there is deliberately NO
 * date-column picker -- the newest date is auto-detected server-side and
 * only displayed here, never chosen by the user. Confirm re-sends the exact
 * previewed rows back to the server rather than re-uploading the file, so a
 * second (possibly non-deterministic, for the OCR/PDF path) parse can never
 * silently diverge from what was actually reviewed on screen.
 */
export function BaselineUploadModal({ open, clientId, onClose, onConfirmed }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<BaselinePreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const handleFileSelected = useCallback(
    async (selected: File) => {
      setFile(selected);
      setPreview(null);
      setError(null);
      setPreviewing(true);
      try {
        const result = await previewBaseline(clientId, selected);
        setPreview(result);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPreviewing(false);
      }
    },
    [clientId],
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) void handleFileSelected(accepted[0]);
    },
    [handleFileSelected],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled: previewing });

  async function handleConfirm() {
    if (!preview) return;
    setConfirming(true);
    setError(null);
    try {
      await confirmBaseline(clientId, preview);
      onConfirmed();
      handleClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Upload Previous Ranking"
      footer={
        preview ? (
          <>
            <Button variant="ghost" onClick={reset}>
              Choose a different file
            </Button>
            <Button disabled={confirming} onClick={handleConfirm}>
              {confirming && <Spinner />}
              Confirm &amp; Store
            </Button>
          </>
        ) : undefined
      }
    >
      {!preview && (
        <div>
          <p className="mb-4 text-sm text-[var(--color-ink-muted)]">
            Upload an agency's existing ranking report (Excel or PDF) as this client's historical baseline. It's stored
            separately from ranking runs and never overwrites anything -- their next completed run will automatically
            compare against it.
          </p>
          <div
            {...getRootProps()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              isDragActive
                ? 'border-brand-400 bg-brand-400/[0.06]'
                : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50 hover:bg-brand-400/[0.03]'
            } ${previewing ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input {...getInputProps()} />
            {previewing ? (
              <div className="flex items-center justify-center gap-2.5 text-[var(--color-ink-muted)]">
                <Spinner className="h-4 w-4" />
                <span className="text-sm font-medium">Extracting {file?.name}...</span>
              </div>
            ) : (
              <div>
                <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
                  <UploadDropIcon className="h-5 w-5" />
                </div>
                <p className="text-sm font-semibold text-[var(--color-ink)]">
                  {isDragActive ? 'Drop the file here' : 'Drop a ranking report here'}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">or click to browse &middot; .xlsx or .pdf</p>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <InlineError message={error} className="mt-3" />}

      {preview && (
        <div>
          <p className="text-sm text-[var(--color-ink)]">
            Using <span className="font-semibold text-brand-300">{preview.baselineDateLabel}</span> as the baseline
            {preview.detectedDates.length > 1 && <> (the newest of {preview.detectedDates.length} ranking dates found)</>}.
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
            {preview.rows.length} keyword{preview.rows.length === 1 ? '' : 's'} extracted from {preview.sourceFilename} --
            review below before confirming.
          </p>
          <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)]">
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
    </Modal>
  );
}
