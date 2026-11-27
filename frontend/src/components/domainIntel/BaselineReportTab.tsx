import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { celebrateReportSent } from '../layout/FestiveSleigh';
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
  getBaselineJobPreview,
  getBaselineJobs,
  previewBaselineClientFile,
  removeBaselineClientFile,
  uploadBaselineClientFile,
  retryBaselineVolumes,
  sendBaselineJobEmail,
  startBaselineJob,
  uploadBaselineKeywordPlanner,
  type BaselineJob,
} from '../../api/client';
import type { BaselineClientPreview as PreviewData } from '../../api/types';
import { BaselineClientPreview } from '../report/BaselineClientPreview';
import { WorkbookPreviewModal } from '../ui/WorkbookPreviewModal';

/**
 * "Baseline Report" tab on Domain Intelligence (2026-11-13): a new client's first report, made once. The team types
 * the client, website, country and keywords; the dashboard checks the ranks on Google, gets the search volumes from
 * Google Keyword Planner, and the Excel is ready to download. Then it's emailed to the new client ONCE from the
 * card (To / CC / ClickUp task), through ClickUp, with the client copy (no Number of Result / SERP result).
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

const STEPS = ['Client & keywords', 'Ranks on Google', 'Search volumes', 'Check & email client'];

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

/** "Email to client": To / CC / ClickUp task + the message, sent once through ClickUp with the client copy. */
function EmailForm({ job, onSent, onCancel }: { job: BaselineJob; onSent: (job: BaselineJob) => void; onCancel: () => void }) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [task, setTask] = useState(job.email.clickupTaskUrl ?? '');
  const [subject, setSubject] = useState(job.email.defaultSubject);
  const [body, setBody] = useState(job.email.defaultBody);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(job.email.error ? `Last try failed: ${job.email.error}` : null);

  async function send() {
    if (!window.confirm(`Send the Baseline Report to ${to.trim()}? It goes to the client only once.`)) return;
    setSending(true);
    setError(null);
    try {
      onSent(await sendBaselineJobEmail(job.id, { to, cc, clickupTask: task, subject, body }));
      celebrateReportSent('Baseline Report sent');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const id = (name: string) => `baseline-${job.id}-${name}`;
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-[var(--color-border)] bg-overlay/[0.02] p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="To" htmlFor={id('to')}>
          <TextInput id={id('to')} value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" disabled={sending} />
        </FormField>
        <FormField label="CC" htmlFor={id('cc')}>
          <TextInput id={id('cc')} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional · comma between addresses" disabled={sending} />
        </FormField>
      </div>
      <FormField label="ClickUp task (link or ID)" htmlFor={id('task')}>
        <TextInput id={id('task')} value={task} onChange={(e) => setTask(e.target.value)} placeholder="https://app.clickup.com/t/86c1abcde" disabled={sending} />
      </FormField>
      <FormField label="Subject" htmlFor={id('subject')}>
        <TextInput id={id('subject')} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sending} />
      </FormField>
      <FormField label="Message" htmlFor={id('body')}>
        <Textarea id={id('body')} rows={7} value={body} onChange={(e) => setBody(e.target.value)} disabled={sending} />
      </FormField>
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        Attaches the client copy of the Excel: Keywords, Avg. Monthly Searches, Competition, Intent and the ranking. Number of Result and SERP result stay internal.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="!py-1.5 text-xs" disabled={sending || !to.trim() || !task.trim()} onClick={() => void send()}>
          {sending && <Spinner />}
          {sending ? 'Sending through ClickUp…' : 'Send to client'}
        </Button>
        <Button variant="ghost" className="!py-1.5 text-xs" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <InlineError message={error} />
    </div>
  );
}

function stateBadge(job: BaselineJob) {
  if (job.state === 'failed') return { label: 'Stopped', tone: 'bg-rose-500/15 text-rose-300' };
  if (job.state === 'checking') return { label: 'Checking ranks', tone: 'bg-sky-500/15 text-sky-300' };
  if (job.state === 'volumes') return { label: 'Getting volumes', tone: 'bg-violet-500/15 text-violet-300' };
  return { label: 'Ready', tone: 'bg-emerald-500/15 text-emerald-300' };
}

function JobCard({ job, onChange }: { job: BaselineJob; onChange: (job: BaselineJob) => void }) {
  const [busy, setBusy] = useState<'download' | 'client' | 'retry' | 'planner' | 'edited' | null>(null);
  // The team's edited client copy (2026-11-27): checked, changed in Excel, uploaded back -- the email sends it.
  const [editedPreviewOpen, setEditedPreviewOpen] = useState(false);
  const editedInput = useRef<HTMLInputElement>(null);
  const canEdit = job.email.state === 'not_sent';
  const [emailing, setEmailing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function openPreview() {
    if (job.editedFile) {
      setEditedPreviewOpen(true);
      return;
    }
    setPreviewOpen(true);
    setPreview(null);
    setPreviewError(null);
    try {
      setPreview(await getBaselineJobPreview(job.id));
    } catch (err) {
      setPreviewError((err as Error).message);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const badge = stateBadge(job);
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const finished = job.state === 'ready' || job.state === 'volumes';

  async function act(kind: 'download' | 'client' | 'retry' | 'planner' | 'edited', fn: () => Promise<void>) {
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
          <Button
            variant="secondary"
            className="!py-1.5 text-xs"
            title="Without Number of Result and SERP result -- the copy for the client"
            disabled={busy !== null || job.state === 'volumes'}
            onClick={() =>
              void act('client', async () =>
                saveBlob(
                  await downloadBaselineJob(job.id, 'client'),
                  job.editedFile?.name ?? `${job.clientName.replace(/[\\/:*?"<>|]/g, '').trim()} - Baseline Report.xlsx`,
                ),
              )
            }
          >
            {busy === 'client' && <Spinner />}
            {job.editedFile ? 'Client copy (edited)' : 'Client copy'}
          </Button>
          <Button variant="secondary" className="!py-1.5 text-xs" disabled={busy !== null || job.state === 'volumes'} onClick={() => void openPreview()}>
            Preview client copy
          </Button>
          {canEdit && job.state === 'ready' && (
            <>
              <input
                ref={editedInput}
                type="file"
                accept=".xlsx"
                className="hidden"
                aria-label="Upload the edited client copy"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void act('edited', async () => onChange(await uploadBaselineClientFile(job.id, file)));
                }}
              />
              <Button variant="secondary" className="!py-1.5 text-xs" disabled={busy !== null} onClick={() => editedInput.current?.click()}>
                {busy === 'edited' && <Spinner />}
                {job.editedFile ? 'Upload another edited copy' : 'Upload edited copy'}
              </Button>
            </>
          )}
          {job.state === 'ready' && job.email.state === 'not_sent' && !emailing && (
            <Button variant="secondary" className="!py-1.5 text-xs" disabled={busy !== null} onClick={() => setEmailing(true)}>
              Email to client
            </Button>
          )}
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
      {job.editedFile && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-emerald-300">
          <CheckCircleIcon className="h-4 w-4" />
          {job.email.state === 'sent' ? 'Sent your edited copy:' : 'The email will send your edited copy:'}
          <span className="font-medium text-[var(--color-ink)]">{job.editedFile.name}</span>
          <span className="text-[var(--color-ink-faint)]">
            ({job.editedFile.by ? `${job.editedFile.by.split('@')[0]}, ` : ''}
            {new Date(job.editedFile.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })})
          </span>
          {canEdit && (
            <button
              type="button"
              className="text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
              disabled={busy !== null}
              onClick={() => void act('edited', async () => onChange(await removeBaselineClientFile(job.id)))}
            >
              Use the dashboard’s copy instead
            </button>
          )}
        </p>
      )}
      {job.state === 'ready' && job.email.state === 'not_sent' && !emailing && (
        <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
          Before sending: preview or download the client copy and check the ranks, volumes and intent. Changed something in Excel? Upload the edited copy —
          that’s what the email sends.
        </p>
      )}
      {emailing && job.email.state === 'not_sent' && (
        <EmailForm
          job={job}
          onCancel={() => setEmailing(false)}
          onSent={(next) => {
            setEmailing(false);
            onChange(next);
          }}
        />
      )}
      {job.email.state === 'sending' && (
        <p className="mt-3 flex items-center gap-2 text-xs text-sky-300">
          <Spinner /> Sending to the client through ClickUp…
        </p>
      )}
      {job.email.state === 'sent' && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
          <CheckCircleIcon className="h-4 w-4 text-emerald-400" />
          Emailed to <span className="font-medium text-[var(--color-ink)]">{job.email.to.join(', ')}</span>
          {job.email.cc.length > 0 && <> (cc {job.email.cc.join(', ')})</>}
          {job.email.sentAt && <> on {new Date(job.email.sentAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}
          {job.email.sentBy && <> by {job.email.sentBy.split('@')[0]}</>}
        </p>
      )}
      {job.email.state === 'not_sent' && job.email.error && !emailing && (
        <p className="mt-2 text-xs text-amber-300">The email didn't go out last time: {job.email.error}</p>
      )}
      <InlineError message={error} className="mt-2" />
      <WorkbookPreviewModal
        title={editedPreviewOpen && job.editedFile ? `${job.editedFile.name} (your edited copy)` : null}
        load={() => previewBaselineClientFile(job.id)}
        onClose={() => setEditedPreviewOpen(false)}
      />
      <BaselineClientPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        preview={preview}
        loading={previewOpen && !preview && !previewError}
        error={previewError}
      />
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
          from Google Keyword Planner, then you check the Excel and email it to the client once (through ClickUp).
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
