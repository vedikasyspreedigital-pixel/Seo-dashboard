import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { FormField } from '../ui/FormField';
import { TextInput, Textarea } from '../ui/TextInput';
import { InlineError } from '../ui/InlineError';
import { Spinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import { CheckCircleIcon, UploadDropIcon, UploadIcon, XCircleIcon } from '../ui/icons';
import {
  downloadBaselineJob,
  getBaselineJobs,
  retryBaselineVolumes,
  startBaselineJob,
  uploadBaselineKeywordPlanner,
  type BaselineJob,
} from '../../api/client';

/**
 * "Baseline Report" tab on Domain Intelligence (2026-11-13): a new client's first report, made once. The team types
 * the client, website, country and keywords; the dashboard checks the ranks on Google, gets the search volumes from
 * Google Keyword Planner, and the Excel is ready to download. Nothing is sent to the client from here.
 */

// The same codes as the backend (backend/reporting/baselineJobs.ts BASELINE_COUNTRIES).
const COUNTRIES = [
  { value: 'au', label: 'Australia' },
  { value: 'in', label: 'India' },
  { value: 'ae', label: 'United Arab Emirates' },
  { value: 'us', label: 'United States' },
  { value: 'uk', label: 'United Kingdom' },
  { value: 'ca', label: 'Canada' },
  { value: 'nz', label: 'New Zealand' },
  { value: 'sa', label: 'Saudi Arabia' },
  { value: 'qa', label: 'Qatar' },
  { value: 'sg', label: 'Singapore' },
];
const COUNTRY_NAME: Record<string, string> = { AU: 'Australia', IN: 'India', AE: 'UAE', US: 'United States', GB: 'United Kingdom', CA: 'Canada', NZ: 'New Zealand', SA: 'Saudi Arabia', QA: 'Qatar', SG: 'Singapore' };
const MAX_KEYWORDS = 300;

const XLSX_TYPES = { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] };
const PLANNER_TYPES = { 'text/csv': ['.csv'], ...XLSX_TYPES };

/** One keyword per line (commas and tabs split too), repeats dropped -- the server does the same. */
function splitKeywords(text: string) {
  const seen = new Set<string>();
  let repeats = 0;
  const list: string[] = [];
  for (const raw of text.split(/[\r\n\t,]+/)) {
    const k = raw.trim().replace(/\s+/g, ' ');
    if (!k) continue;
    if (seen.has(k.toLowerCase())) {
      repeats++;
      continue;
    }
    seen.add(k.toLowerCase());
    list.push(k);
  }
  return { list, repeats };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const STEPS = ['Client & keywords', 'Ranks on Google', 'Search volumes', 'Download Excel'];

function Steps() {
  return (
    <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-overlay/[0.02] px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-semibold text-brand-300">{i + 1}</span>
          <span className="text-xs text-[var(--color-ink-muted)]">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function KeywordFileDrop({ file, onFile, disabled }: { file: File | null; onFile: (f: File | null) => void; disabled: boolean }) {
  const onDrop = useCallback((accepted: File[]) => accepted[0] && onFile(accepted[0]), [onFile]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: XLSX_TYPES, multiple: false, disabled });
  return (
    <div className="flex items-center gap-2">
      <div
        {...getRootProps()}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors ${
          isDragActive ? 'border-brand-400 bg-brand-500/10' : 'border-[var(--color-border-strong)] hover:bg-overlay/[0.03]'
        }`}
      >
        <input {...getInputProps()} />
        <UploadDropIcon className="h-5 w-5 shrink-0 text-[var(--color-ink-faint)]" />
        <span className={file ? 'truncate text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'}>
          {file ? file.name : 'Or drop an Excel with a “Keywords” column · .xlsx'}
        </span>
      </div>
      {file && (
        <Button variant="ghost" className="!px-3 !py-2 text-xs" disabled={disabled} onClick={() => onFile(null)}>
          Remove
        </Button>
      )}
    </div>
  );
}

function PlannerUpload({ onFile, busy }: { onFile: (f: File) => void; busy: boolean }) {
  const onDrop = useCallback((accepted: File[]) => accepted[0] && onFile(accepted[0]), [onFile]);
  const { getRootProps, getInputProps } = useDropzone({ onDrop, accept: PLANNER_TYPES, multiple: false, disabled: busy });
  return (
    <span {...getRootProps()}>
      <input {...getInputProps()} />
      <Button variant="secondary" className="!py-1.5 text-xs" disabled={busy}>
        {busy ? <Spinner /> : <UploadIcon className="h-3.5 w-3.5" />}
        Upload Keyword Planner file
      </Button>
    </span>
  );
}

function stateBadge(job: BaselineJob) {
  if (job.state === 'failed') return { label: 'Stopped', tone: 'bg-rose-500/15 text-rose-300' };
  if (job.state === 'checking') return { label: 'Checking ranks', tone: 'bg-sky-500/15 text-sky-300' };
  if (job.state === 'volumes') return { label: 'Getting volumes', tone: 'bg-violet-500/15 text-violet-300' };
  return { label: 'Ready', tone: 'bg-emerald-500/15 text-emerald-300' };
}

function JobCard({ job, onChange }: { job: BaselineJob; onChange: (job: BaselineJob) => void }) {
  const [busy, setBusy] = useState<'download' | 'retry' | 'planner' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const badge = stateBadge(job);
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const finished = job.state === 'ready' || job.state === 'volumes';

  async function act(kind: 'download' | 'retry' | 'planner', fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-2xl border border-[var(--color-border)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            {job.clientName}
            {job.domain && <span className="ml-2 font-normal text-[var(--color-ink-muted)]">{job.domain}</span>}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            {COUNTRY_NAME[job.country] ?? job.country} · {job.total} keywords ·{' '}
            {new Date(job.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {job.createdBy && ` · ${job.createdBy.split('@')[0]}`}
          </p>
        </div>
        <StatusBadge label={badge.label} toneClassName={badge.tone} />
      </div>

      {job.state === 'checking' && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-[var(--color-ink-muted)]">
            <span className="flex items-center gap-2">
              <Spinner /> Checking {job.done} of {job.total} keywords on Google…
            </span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-overlay/[0.06]">
            <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">You can leave this page — it keeps going on the server.</p>
        </div>
      )}

      {finished && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <span className="flex items-center gap-1.5 text-[var(--color-ink-muted)]">
            <CheckCircleIcon className="h-4 w-4 text-emerald-400" />
            Ranks: <span className="font-semibold text-[var(--color-ink)]">{job.ranked}</span> of {job.total} in the top 100
          </span>
          <span className="flex items-center gap-1.5 text-[var(--color-ink-muted)]">
            {job.volumes === 'fetched' ? (
              <>
                <CheckCircleIcon className="h-4 w-4 text-emerald-400" /> Search volumes added
              </>
            ) : job.volumes === 'fetching' ? (
              <>
                <Spinner /> Getting search volumes from Keyword Planner…
              </>
            ) : (
              <>
                <XCircleIcon className="h-4 w-4 text-amber-400" />
                {job.volumes === 'not_set_up' ? 'Google Ads isn’t set up on the server — no volumes' : 'Search volumes didn’t come through'}
              </>
            )}
          </span>
        </div>
      )}

      {job.volumes === 'failed' && job.volumesError && <p className="mt-2 text-xs text-amber-300">{job.volumesError}</p>}
      {job.state === 'failed' && <p className="mt-2 text-xs text-rose-300">The check was stopped before every keyword was done.</p>}

      {(finished || job.state === 'failed') && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            className="!py-1.5 text-xs"
            disabled={busy !== null || job.state === 'volumes'}
            onClick={() =>
              void act('download', async () => saveBlob(await downloadBaselineJob(job.id), `${job.clientName.replace(/[\\/:*?"<>|]/g, '').trim()} - Baseline Report.xlsx`))
            }
          >
            {busy === 'download' && <Spinner />}
            Download Baseline Excel
          </Button>
          {(job.volumes === 'failed' || job.volumes === 'not_set_up') && (
            <>
              {job.volumes === 'failed' && (
                <Button variant="secondary" className="!py-1.5 text-xs" disabled={busy !== null} onClick={() => void act('retry', async () => onChange(await retryBaselineVolumes(job.id)))}>
                  {busy === 'retry' && <Spinner />}
                  Try volumes again
                </Button>
              )}
              <PlannerUpload busy={busy === 'planner'} onFile={(f) => void act('planner', async () => onChange(await uploadBaselineKeywordPlanner(job.id, f)))} />
            </>
          )}
        </div>
      )}
      {job.state === 'ready' && (
        <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
          Before sending: fill “Number of Result” by hand (incognito Google search → Tools → “About X results”) and look over the ranks.
        </p>
      )}
      <InlineError message={error} className="mt-2" />
    </li>
  );
}

export function BaselineReportTab({ workspaceId }: { workspaceId: string | null }) {
  const [clientName, setClientName] = useState('');
  const [website, setWebsite] = useState('');
  const [country, setCountry] = useState('au');
  const [keywordText, setKeywordText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BaselineJob[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const shownWorkspace = useRef(workspaceId);

  const { list, repeats } = useMemo(() => splitKeywords(keywordText), [keywordText]);

  const load = useCallback(async () => {
    if (!workspaceId) return setJobs([]);
    try {
      const next = await getBaselineJobs(workspaceId);
      if (shownWorkspace.current === workspaceId) {
        setJobs(next);
        setListError(null);
      }
    } catch (err) {
      if (shownWorkspace.current === workspaceId) setListError((err as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    shownWorkspace.current = workspaceId;
    setJobs([]);
    void load();
  }, [workspaceId, load]);

  // Follow the ones still going.
  const anyRunning = jobs.some((j) => j.state === 'checking' || j.state === 'volumes');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [anyRunning, load]);

  const problem = !workspaceId
    ? 'No workspace selected.'
    : !clientName.trim()
      ? 'Enter the client’s name.'
      : !website.trim()
        ? 'Enter the client’s website.'
        : list.length === 0 && !file
          ? 'Paste the keywords (one per line) or drop an Excel.'
          : list.length > MAX_KEYWORDS
            ? `That’s ${list.length} keywords — at most ${MAX_KEYWORDS} per Baseline Report.`
            : null;

  async function handleStart() {
    if (problem || !workspaceId) return;
    setStarting(true);
    setError(null);
    try {
      const job = await startBaselineJob({ workspaceId, clientName: clientName.trim(), websiteUrl: website.trim(), country, keywords: keywordText, file });
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setClientName('');
      setWebsite('');
      setKeywordText('');
      setFile(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <Card className="p-6">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">New Baseline Report</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          A new client’s first report. Add their keywords — the dashboard checks where the website ranks on Google, adds the search volume and competition
          from Google Keyword Planner, and you download the Excel. Nothing is sent to the client from here.
        </p>
        <Steps />

        <div className="mt-6 grid gap-5 md:grid-cols-3">
          <FormField label="Client name" htmlFor="bl-client">
            <TextInput id="bl-client" value={clientName} placeholder="e.g. Venezia Designs" onChange={(e) => setClientName(e.target.value)} disabled={starting} />
          </FormField>
          <FormField label="Website" htmlFor="bl-site">
            <TextInput id="bl-site" value={website} placeholder="e.g. veneziadesigns.com" onChange={(e) => setWebsite(e.target.value)} disabled={starting} />
          </FormField>
          <FormField label="Country (Google & Keyword Planner)">
            <Select value={country} onChange={setCountry} placeholder="Select a country..." options={COUNTRIES} disabled={starting} />
          </FormField>
        </div>

        <div className="mt-5">
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label htmlFor="bl-keywords" className="text-sm font-medium text-[var(--color-ink-muted)]">
              Keywords <span className="font-normal text-[var(--color-ink-faint)]">— one per line</span>
            </label>
            <span className="text-xs text-[var(--color-ink-faint)]">
              {list.length} keyword{list.length === 1 ? '' : 's'}
              {repeats > 0 && ` · ${repeats} repeat${repeats === 1 ? '' : 's'} removed`}
            </span>
          </div>
          <Textarea
            id="bl-keywords"
            rows={8}
            value={keywordText}
            placeholder={'kitchen renovation dubai\nmodular kitchen dubai\nluxury kitchens dubai'}
            onChange={(e) => setKeywordText(e.target.value)}
            disabled={starting}
          />
          <div className="mt-2">
            <KeywordFileDrop file={file} onFile={setFile} disabled={starting} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button disabled={!!problem || starting} onClick={() => void handleStart()}>
            {starting && <Spinner />}
            Create Baseline Report
          </Button>
          <span className="text-xs text-[var(--color-ink-faint)]">
            {problem ?? `Takes a few seconds per keyword — about ${Math.max(1, Math.ceil((list.length || 10) / 6))} min for ${list.length || 'these'} keywords.`}
          </span>
        </div>
        <InlineError message={error} className="mt-3" />
      </Card>

      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Baseline Reports</h2>
        {listError && jobs.length === 0 ? (
          <p className="mt-3 text-sm text-rose-300">
            Couldn't load them ({listError}).{' '}
            <button type="button" className="underline" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : jobs.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">No Baseline Reports yet — the first one you create shows up here.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onChange={(next) => setJobs((prev) => prev.map((x) => (x.id === next.id ? next : x)))} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
