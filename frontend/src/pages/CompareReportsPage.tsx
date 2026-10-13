import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { AppShell } from '../components/layout/AppShell';
import { PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { InlineError } from '../components/ui/InlineError';
import { FormField } from '../components/ui/FormField';
import { TextInput } from '../components/ui/TextInput';
import { UploadDropIcon } from '../components/ui/icons';
import { compareReports, compareReportsPdf, type ReportComparison } from '../api/client';

const ACCEPTED = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

/** One upload box: drop or browse a single rankings Excel from your folder. */
function UploadBox({ label, file, onFile, disabled }: { label: string; file: File | null; onFile: (f: File) => void; disabled: boolean }) {
  const onDrop = useCallback((accepted: File[]) => accepted[0] && onFile(accepted[0]), [onFile]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPTED, maxFiles: 1, disabled });
  return (
    <div
      {...getRootProps()}
      className={`flex min-h-[150px] flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors ${
        isDragActive
          ? 'border-brand-400 bg-brand-400/[0.06]'
          : file
            ? 'border-brand-400/40 bg-brand-400/[0.03]'
            : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-brand-400/50 hover:bg-brand-400/[0.03]'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input {...getInputProps()} />
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-400/15 text-brand-300">
        <UploadDropIcon className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-[var(--color-ink)]">{label}</p>
      {file ? (
        <p className="mt-1 max-w-full truncate text-xs text-brand-300" title={file.name}>
          {file.name}
        </p>
      ) : (
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Drop a rankings Excel here or click to browse · .xlsx</p>
      )}
    </div>
  );
}

/** An upload box with the date its rankings were checked underneath (a rankings Excel has no date inside). */
function UploadWithDate(props: { label: string; file: File | null; onFile: (f: File) => void; date: string; onDate: (d: string) => void; disabled: boolean }) {
  const id = `cmp-date-${props.label.replace(/s+/g, '-').toLowerCase()}`;
  return (
    <div className="flex flex-1 flex-col gap-3">
      <UploadBox label={props.label} file={props.file} onFile={props.onFile} disabled={props.disabled} />
      <FormField label="Date these rankings were checked" htmlFor={id}>
        <TextInput id={id} type="date" value={props.date} disabled={props.disabled} onChange={(e) => props.onDate(e.target.value)} />
      </FormField>
    </div>
  );
}

/**
 * "Compare Reports": pick two rankings Excels from your folder, give each the
 * date it was checked, compare them, and download the comparison PDF. Nothing is saved -- no client, run,
 * baseline or report in the app is read or changed, and no email is sent.
 */
export function CompareReportsPage() {
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [date1, setDate1] = useState('');
  const [date2, setDate2] = useState('');
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const [clientName, setClientName] = useState('');
  const [clientDomain, setClientDomain] = useState('');
  const [pdf, setPdf] = useState<{ url: string; fileName: string } | null>(null);
  const [buildingPdf, setBuildingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Free the previous PDF's object URL whenever it's replaced or the page closes.
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);

  async function buildPdf(c: ReportComparison, name: string, domain: string) {
    setBuildingPdf(true);
    setError(null);
    try {
      const { blob, fileName } = await compareReportsPdf(c, name, domain);
      setPdf({ url: URL.createObjectURL(blob), fileName });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuildingPdf(false);
    }
  }

  async function handleCompare() {
    if (!ready || comparing) return;
    setComparing(true);
    setError(null);
    try {
      const result = await compareReports(file1!, date1, file2!, date2);
      setComparison(result);
      setClientName(result.clientName);
      setClientDomain(result.clientDomain ?? '');
      await buildPdf(result, result.clientName, result.clientDomain ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setComparing(false);
    }
  }

  function startOver() {
    setComparison(null);
    setPdf(null);
    setFile1(null);
    setFile2(null);
    setDate1('');
    setDate2('');
    setError(null);
  }

  const sameDate = !!date1 && date1 === date2;
  const ready = !!file1 && !!file2 && !!date1 && !!date2 && !sameDate;

  // ---- Step 2: the generated PDF, with Download top-right ----
  if (comparison) {
    const s = comparison.summary;
    return (
      <AppShell>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageTitle title="Compare Reports" subtitle={`${comparison.older.fileName}  →  ${comparison.newer.fileName}`} className="mt-0" />
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={startOver}>
              Start over
            </Button>
            {pdf && (
              <a href={pdf.url} download={pdf.fileName}>
                <Button>Download</Button>
              </a>
            )}
          </div>
        </div>

        <Card className="mt-5 p-5">
          <p className="text-sm text-[var(--color-ink-muted)]">
            Comparing <span className="font-semibold text-[var(--color-ink)]">{comparison.newer.dateLabel}</span> against{' '}
            <span className="font-semibold text-[var(--color-ink)]">{comparison.older.dateLabel}</span>
            <span className="text-[var(--color-ink-faint)]">
              {' '}
              · {s.matched} keywords matched{s.onlyInNewer ? ` · ${s.onlyInNewer} only in ${comparison.newer.dateLabel}` : ''}
              {s.onlyInOlder ? ` · ${s.onlyInOlder} only in ${comparison.older.dateLabel}` : ''}
            </span>
          </p>
          <p className="mt-1 text-sm">
            <span className="text-brand-300">{s.improved} improved</span>
            <span className="text-[var(--color-ink-faint)]"> · </span>
            <span className="text-rose-300">{s.declined} declined</span>
            <span className="text-[var(--color-ink-faint)]"> · </span>
            <span className="text-[var(--color-ink-muted)]">{s.unchanged} unchanged</span>
          </p>
          {comparison.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {comparison.warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <FormField label="Client name (PDF title)" htmlFor="cmp-client">
              <TextInput id="cmp-client" value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </FormField>
            <FormField label="Website (under the title)" htmlFor="cmp-domain">
              <TextInput id="cmp-domain" value={clientDomain} placeholder="e.g. twincrown.com" onChange={(e) => setClientDomain(e.target.value)} />
            </FormField>
            <Button variant="secondary" disabled={buildingPdf || !clientName.trim()} onClick={() => void buildPdf(comparison, clientName, clientDomain)}>
              {buildingPdf && <Spinner />}
              Update PDF
            </Button>
          </div>
          <InlineError message={error} className="mt-3" />
        </Card>

        <Card className="mt-4 overflow-hidden p-0">
          {buildingPdf && !pdf ? (
            <div className="flex h-[70vh] items-center justify-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Spinner /> Generating the report PDF…
            </div>
          ) : pdf ? (
            <iframe title="Comparison report PDF" src={pdf.url} className="h-[78vh] w-full bg-white" />
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-[var(--color-ink-muted)]">The PDF couldn’t be generated — see the message above.</div>
          )}
        </Card>
      </AppShell>
    );
  }

  // ---- Step 1: Upload 1  and  Upload 2  ->  Compare and next ----
  return (
    <AppShell>
      <PageTitle
        title="Compare Reports"
        subtitle="Upload two rankings Excels from your folder and pick the date each one was checked. The later date is compared against the earlier one. Nothing is saved and no email is sent."
        className="mt-0"
      />
      <Card className="mt-6 p-6">
        <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-start">
          <UploadWithDate label="Upload 1" file={file1} onFile={setFile1} date={date1} onDate={setDate1} disabled={comparing} />
          <span className="text-center text-sm font-medium text-[var(--color-ink-faint)] md:mt-[68px]">and</span>
          <UploadWithDate label="Upload 2" file={file2} onFile={setFile2} date={date2} onDate={setDate2} disabled={comparing} />
        </div>
        {sameDate && <p className="mt-3 text-center text-xs text-amber-300">Both dates are the same — pick two different dates.</p>}
        <div className="mt-6 flex justify-center">
          <Button disabled={!ready || comparing} onClick={() => void handleCompare()}>
            {comparing && <Spinner />}
            {comparing ? 'Comparing…' : 'Compare and next'}
          </Button>
        </div>
        <InlineError message={error} className="mt-4" />
      </Card>
    </AppShell>
  );
}
