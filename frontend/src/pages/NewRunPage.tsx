import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { InlineError } from '../components/ui/InlineError';
import { ExcelDropzone, type FileValidationState } from '../components/upload/ExcelDropzone';
import { useActiveClient } from '../context/ClientContext';
import { useToast } from '../context/ToastContext';
import { createRun, validateRunFile } from '../api/client';

export function NewRunPage() {
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();
  const { showToast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<FileValidationState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The file whose check is the latest: a slower check of a file picked earlier must not overwrite it (audit 2026-10-27).
  const latestFile = useRef<File | null>(null);

  async function handleFileSelected(selected: File) {
    setFile(selected);
    setError(null);
    latestFile.current = selected;
    if (!activeClient) return;
    setValidation({ status: 'validating' });
    try {
      const result = await validateRunFile(activeClient.id, selected);
      if (latestFile.current !== selected) return;
      // No usable rows = nothing to run (the server refuses it too).
      if (result.insertedRowCount === 0) {
        setValidation({
          status: 'invalid',
          message: `No keyword rows could be read from this file${result.rowErrors[0] ? ` (row ${result.rowErrors[0].sourceRowNumber}: ${result.rowErrors[0].reason})` : ''}.`,
        });
        return;
      }
      setValidation({ status: 'valid', ...result });
    } catch (err) {
      if (latestFile.current !== selected) return;
      setValidation({ status: 'invalid', message: (err as Error).message });
    }
  }

  // A file picked before a client was chosen was never checked, so Start stayed disabled -- check it once
  // there is a client (audit 2026-10-27).
  useEffect(() => {
    if (activeClient && file && !validation) void handleFileSelected(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClient?.id]);

  async function handleSubmit() {
    if (!activeClient || !file) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createRun(activeClient.id, file);
      // Shown as a toast: set on this page, it vanished with the move to the run (audit 2026-10-27).
      if (result.rowErrors.length > 0) {
        showToast(`${result.insertedRowCount} row(s) added, ${result.rowErrors.length} skipped: ${result.rowErrors[0].reason}`, 'warning');
      }
      navigate(`/runs/${result.run.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = Boolean(file) && Boolean(activeClient) && validation?.status === 'valid' && !submitting;

  return (
    <AppShell>
      <PageHeader breadcrumbs={[{ label: 'Runs', to: '/runs' }, { label: 'New Run' }]} />
      <PageTitle title="New Ranking Run" subtitle={activeClient?.name} />

      <Card className="mt-6 p-6">
        <p className="eyebrow-label">Client</p>
        <div className="mt-1.5 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink-muted)]">
          {activeClient?.name ?? 'No client selected'}
        </div>

        <div className="mt-5">
          <ExcelDropzone file={file} validation={validation} onFileSelected={handleFileSelected} disabled={submitting} />
        </div>

        <InlineError message={error} className="mt-4" />

        <div className="mt-6 flex items-center gap-3">
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {submitting && <Spinner />}
            Upload &amp; Create Run
          </Button>
          <Button variant="ghost" onClick={() => navigate('/runs')}>
            Cancel
          </Button>
        </div>
      </Card>
    </AppShell>
  );
}
