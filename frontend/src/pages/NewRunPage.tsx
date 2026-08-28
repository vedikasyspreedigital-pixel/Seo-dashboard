import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { ExcelDropzone, type FileValidationState } from '../components/upload/ExcelDropzone';
import { useActiveClient } from '../context/ClientContext';
import { createRun, validateRunFile } from '../api/client';

export function NewRunPage() {
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<FileValidationState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(selected: File) {
    setFile(selected);
    setError(null);
    if (!activeClient) return;
    setValidation({ status: 'validating' });
    try {
      const result = await validateRunFile(activeClient.id, selected);
      setValidation({ status: 'valid', ...result });
    } catch (err) {
      setValidation({ status: 'invalid', message: (err as Error).message });
    }
  }

  async function handleSubmit() {
    if (!activeClient || !file) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createRun(activeClient.id, file);
      if (result.rowErrors.length > 0) {
        setError(`${result.insertedRowCount} row(s) inserted, ${result.rowErrors.length} skipped: ${result.rowErrors[0].reason}`);
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
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Client</p>
        <div className="mt-1.5 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink-muted)]">
          {activeClient?.name ?? 'No client selected'}
        </div>

        <div className="mt-5">
          <ExcelDropzone file={file} validation={validation} onFileSelected={handleFileSelected} disabled={submitting} />
        </div>

        {error && <p className="mt-4 text-sm font-medium text-rose-300">{error}</p>}

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
