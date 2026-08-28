import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadDropIcon, CheckCircleIcon, AlertTriangleIcon } from '../ui/icons';
import { Spinner } from '../ui/Spinner';

export type FileValidationState =
  | { status: 'validating' }
  | { status: 'valid'; insertedRowCount: number; rowErrorCount: number; detectedColumns: string[]; fileSizeBytes: number }
  | { status: 'invalid'; message: string };

interface Props {
  file: File | null;
  validation: FileValidationState | null;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

export function ExcelDropzone({ file, validation, onFileSelected, disabled }: Props) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) onFileSelected(accepted[0]);
    },
    [onFileSelected]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED,
    maxFiles: 1,
    disabled,
  });

  const isInvalid = validation?.status === 'invalid';
  const isValid = validation?.status === 'valid';

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Ranking Excel file</label>
      <div
        {...getRootProps()}
        className={`cursor-pointer rounded-xl transition-colors ${
          isValid
            ? 'border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]'
            : `border-2 border-dashed px-6 py-8 text-center ${
                isInvalid
                  ? 'border-rose-500/40 bg-rose-500/[0.04]'
                  : isDragActive
                    ? 'border-brand-400 bg-brand-400/[0.06]'
                    : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50 hover:bg-brand-400/[0.03]'
              }`
        } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        <input {...getInputProps()} />

        {!file && (
          <div>
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
              <UploadDropIcon className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">
              {isDragActive ? 'Drop the file here' : 'Drop your keyword Excel here'}
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">or click to browse &middot; .xlsx only</p>
          </div>
        )}

        {file && validation?.status === 'validating' && (
          <div className="flex items-center justify-center gap-2.5 text-[var(--color-ink-muted)]">
            <Spinner className="h-4 w-4" />
            <span className="text-sm font-medium">Validating {file.name}...</span>
          </div>
        )}

        {file && isInvalid && (
          <div>
            <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-rose-500/15 text-rose-300">
              <AlertTriangleIcon className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">{file.name}</p>
            <p className="mt-1 text-xs text-rose-300">{validation.message}</p>
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Click or drop to try a different file</p>
          </div>
        )}

        {file && isValid && (
          <div className="text-left">
            <div className="flex items-center gap-3 border-b border-[var(--color-border)] p-5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <CheckCircleIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-brand-300">{file.name}</p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                  {validation.insertedRowCount} row{validation.insertedRowCount === 1 ? '' : 's'} ready &middot;{' '}
                  {validation.rowErrorCount} skipped &middot; {(validation.fileSizeBytes / 1024).toFixed(0)} KB
                </p>
              </div>
            </div>
            <div className="p-5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Required columns detected</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {validation.detectedColumns.map((column) => (
                  <span
                    key={column}
                    className="rounded-full border border-brand-400/30 bg-brand-400/10 px-3 py-1 font-mono text-xs font-semibold text-brand-300"
                  >
                    {column}
                  </span>
                ))}
              </div>
              <p className="mt-4 text-xs text-[var(--color-ink-faint)]">Click or drop to replace</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
