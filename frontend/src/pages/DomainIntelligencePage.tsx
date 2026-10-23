import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { AppShell } from '../components/layout/AppShell';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { FormField } from '../components/ui/FormField';
import { TextInput } from '../components/ui/TextInput';
import { InlineError } from '../components/ui/InlineError';
import { Spinner } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
import { GlobeIcon, UploadDropIcon } from '../components/ui/icons';
import { useActiveClient } from '../context/ClientContext';
import { competitorProblems, fillFromPaste, toDomain } from '../utils/competitorDomains';
import {
  createDomainReport,
  downloadDomainReportFile,
  getDomainFetch,
  getDomainFetchStatus,
  getCompetitorSearch,
  getDomainReports,
  retryDomainReportPost,
  startCompetitorSearch,
  startDomainFetch,
  type DomainCompetitorSearch,
  type DomainFetchJob,
  type DomainFetchStatus,
  type DomainReport,
  type DomainReportMode,
  type DomainReportStatus,
  type DomainSource,
} from '../api/client';

const SOURCES: { value: DomainSource; label: string }[] = [
  { value: 'semrush', label: 'Semrush' },
  { value: 'ubersuggest', label: 'Ubersuggest' },
  { value: 'ahrefs', label: 'Ahrefs' },
];

// Same codes as backend/domainIntel/createDomainReport.ts LOCATIONS.
const LOCATIONS = [
  { value: 'au', label: 'Australia' },
  { value: 'us', label: 'United States' },
  { value: 'uk', label: 'United Kingdom' },
  { value: 'ca', label: 'Canada' },
  { value: 'nz', label: 'New Zealand' },
  { value: 'in', label: 'India' },
  { value: 'ae', label: 'United Arab Emirates' },
  { value: 'sa', label: 'Saudi Arabia' },
  { value: 'qa', label: 'Qatar' },
  { value: 'sg', label: 'Singapore' },
];

const MODES: { value: DomainReportMode; label: string }[] = [
  { value: 'combined', label: 'Combined report only' },
  { value: 'individual', label: 'Individual source reports' },
  { value: 'both', label: 'Combined and individual reports' },
];

const STATUS: Record<DomainReportStatus, { label: string; tone: string }> = {
  GENERATING: { label: 'Generating', tone: 'bg-overlay/[0.06] text-[var(--color-ink-muted)]' },
  GENERATED: { label: 'Waiting to post', tone: 'bg-overlay/[0.06] text-[var(--color-ink-muted)]' },
  POSTING: { label: 'Posting to ClickUp', tone: 'bg-brand-500/15 text-brand-300' },
  POSTED: { label: 'Posted to ClickUp', tone: 'bg-emerald-500/15 text-emerald-300' },
  POST_FAILED: { label: 'Post failed', tone: 'bg-rose-500/15 text-rose-300' },
  NOT_POSTED: { label: 'Not posted', tone: 'bg-amber-500/10 text-amber-300' },
};

const EXPORT_TYPES = {
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

/** One tool's export: drop or browse a single .csv/.xlsx. */
function ExportDrop({ file, onFile, disabled }: { file: File | null; onFile: (f: File) => void; disabled: boolean }) {
  const onDrop = useCallback((accepted: File[]) => accepted[0] && onFile(accepted[0]), [onFile]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: EXPORT_TYPES, multiple: false, disabled });
  return (
    <div
      {...getRootProps()}
      className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors ${
        isDragActive ? 'border-brand-400 bg-brand-500/10' : 'border-[var(--color-border-strong)] hover:bg-overlay/[0.03]'
      }`}
    >
      <input {...getInputProps()} />
      <UploadDropIcon className="h-5 w-5 shrink-0 text-[var(--color-ink-faint)]" />
      <span className={file ? 'truncate text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'}>
        {file ? file.name : 'Drop the keywords export here or click to browse · .csv or .xlsx'}
      </span>
    </div>
  );
}

/**
 * A tool the server can fetch by itself (Ahrefs via Flikover): "Fetch from …"
 * runs in the background while the other files are uploaded; when it's done
 * the fetched file shows here as attached. Uploading the file by hand stays
 * possible at any time (and wins over a fetch).
 */
function FetchSlot({
  label,
  job,
  file,
  mock,
  agentNote,
  canStart,
  disabled,
  onStart,
  onFile,
}: {
  label: string;
  job: DomainFetchJob | null;
  file: File | null;
  mock: boolean;
  /** "agent" mode: whether the office Chrome is ready to take the job. */
  agentNote?: string;
  canStart: boolean;
  disabled: boolean;
  onStart: () => void;
  onFile: (f: File | null) => void;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const running = job?.state === 'queued' || job?.state === 'fetching';

  if (file || showUpload) {
    return (
      <div className="flex flex-col gap-1">
        <ExportDrop file={file} onFile={onFile} disabled={disabled} />
        <button
          type="button"
          className="w-fit text-xs font-medium text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
          onClick={() => {
            onFile(null);
            setShowUpload(false);
          }}
          disabled={disabled}
        >
          Fetch from {label} instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm">
      {!job && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" className="!py-1.5 text-xs" disabled={!canStart || disabled} onClick={onStart}>
            Fetch from {label}
          </Button>
          <span className="text-xs text-[var(--color-ink-faint)]">
            Runs in the background (about a minute) — upload the other files meanwhile.{mock && ' Mock mode on this server: no real Flikover.'}
            {agentNote && ` ${agentNote}`}
          </span>
        </div>
      )}
      {running && (
        <div className="flex items-center gap-2 text-brand-300">
          <Spinner />
          <span>
            Fetching from {label}…{job?.step ? ` ${job.step}` : ''}
          </span>
        </div>
      )}
      {job?.state === 'done' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-emerald-300">✓ Attached</span>
          <span className="truncate text-[var(--color-ink)]">{job.fileName}</span>
          <span className="text-xs text-[var(--color-ink-muted)]">· {job.keywords} keywords · fetched {new Date(job.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
          <button type="button" className="text-xs font-medium text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] hover:underline" onClick={onStart} disabled={disabled}>
            Fetch again
          </button>
        </div>
      )}
      {job?.state === 'failed' && (
        <>
          <p className="text-amber-300">{job.error}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" className="!py-1 text-xs" disabled={!canStart || disabled} onClick={onStart}>
              Try again
            </Button>
          </div>
        </>
      )}
      {!running && (
        <button
          type="button"
          className="w-fit text-xs font-medium text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
          onClick={() => setShowUpload(true)}
          disabled={disabled}
        >
          Upload the {label} file instead
        </button>
      )}
    </div>
  );
}

const COMPETITOR_COUNT = 3;

/**
 * Keyword Analysis competitors (team's decision, 2026-10-23): "Find competitors" reads Semrush's Main
 * Organic Competitors (top 3 pre-filled, editable), then each one's Semrush keywords are fetched; the
 * report gets a "Competitors" sheet with the client's and their keywords side by side.
 */
function CompetitorsSection({
  search,
  domains,
  problems,
  jobs,
  canStart,
  disabled,
  onFind,
  onDomain,
  onPaste,
  onFetch,
}: {
  search: DomainCompetitorSearch | null;
  domains: string[];
  /** Per box: why it can't be used (null = fine or empty). */
  problems: (string | null)[];
  jobs: (DomainFetchJob | null)[];
  canStart: boolean;
  disabled: boolean;
  onFind: () => void;
  onDomain: (i: number, value: string) => void;
  /** A pasted list fills several boxes; returns false for a single entry (the box takes it as typed). */
  onPaste: (i: number, text: string) => boolean;
  onFetch: () => void;
}) {
  const searching = search?.state === 'queued' || search?.state === 'running';
  const anyRunning = jobs.some((j) => j?.state === 'queued' || j?.state === 'fetching');
  const filled = domains.filter((d) => d.trim()).length;
  const blocked = problems.some(Boolean);
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-[var(--color-ink-muted)]">Competitors (optional)</p>
      <p className="mb-3 text-xs text-[var(--color-ink-faint)]">
        Adds a “Competitors” sheet to the Keyword Analysis: the client’s Semrush keywords and up to {COMPETITOR_COUNT} competitors’ side by side — position, landing page, traffic, difficulty and intent.
        Find them in Semrush, or type or paste the competitors’ websites (a full URL or a list works too).
      </p>
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" className="!py-1.5 text-xs" disabled={!canStart || disabled || searching} onClick={onFind}>
            {search?.state === 'done' ? 'Find competitors again' : 'Find competitors (Semrush)'}
          </Button>
          {searching && (
            <span className="flex items-center gap-2 text-brand-300">
              <Spinner /> {search?.step ?? 'Finding competitors…'}
            </span>
          )}
          {search?.state === 'done' && <span className="text-xs text-[var(--color-ink-muted)]">Top {COMPETITOR_COUNT} from Semrush’s Main Organic Competitors — change any of them below.</span>}
          {search?.state === 'failed' && <span className="text-amber-300">{search.error}</span>}
        </div>
        {domains.map((d, i) => {
          const job = jobs[i];
          const info = search?.competitors?.find((c) => c.domain === d.trim().toLowerCase());
          return (
            <div key={i} className="flex flex-wrap items-center gap-3">
              <div className="w-72 max-w-full">
                <TextInput
                  value={d}
                  placeholder={`competitor${i + 1}.com.au`}
                  aria-label={`Competitor ${i + 1} website`}
                  aria-invalid={!!problems[i]}
                  onChange={(e) => onDomain(i, e.target.value)}
                  onPaste={(e) => {
                    if (onPaste(i, e.clipboardData.getData('text'))) e.preventDefault();
                  }}
                  onBlur={() => d.trim() && onDomain(i, toDomain(d))}
                  disabled={disabled || anyRunning}
                />
              </div>
              {problems[i] && <span className="text-xs text-amber-300">{problems[i]}</span>}
              {!problems[i] && info?.commonKeywords != null && <span className="text-xs text-[var(--color-ink-faint)]">{info.commonKeywords} shared keywords</span>}
              {(job?.state === 'queued' || job?.state === 'fetching') && (
                <span className="flex items-center gap-2 text-xs text-brand-300">
                  <Spinner /> {job.step ?? 'Fetching…'}
                </span>
              )}
              {job?.state === 'done' && <span className="text-xs text-emerald-300">✓ {job.keywords} keywords</span>}
              {job?.state === 'failed' && <span className="text-xs text-amber-300">{job.error}</span>}
            </div>
          );
        })}
        <div>
          <Button variant="secondary" className="!py-1.5 text-xs" disabled={!canStart || disabled || anyRunning || filled === 0 || blocked} onClick={onFetch}>
            Fetch competitors’ keywords
          </Button>
        </div>
      </div>
    </div>
  );
}

async function saveFile(reportId: string, index: number, name: string) {
  const blob = await downloadDomainReportFile(reportId, index);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function sourceSummary(report: DomainReport) {
  return SOURCES.filter((s) => report.summary.sources?.[s.value])
    .map((s) => `${s.label} ${report.summary.sources![s.value]!.keywords}`)
    .join(' · ');
}

/**
 * "Domain Intelligence": a client's Semrush / Ubersuggest / Ahrefs keyword
 * exports -> one combined and/or per-tool Excel with one search intent per
 * keyword, posted as a comment on the client's domain-report ClickUp task.
 * Ahrefs can be fetched automatically while the other two are uploaded;
 * nothing is combined or posted until "Combine and post".
 */
export function DomainIntelligencePage() {
  const { clients, activeClient } = useActiveClient();
  const [clientId, setClientId] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [location, setLocation] = useState('au');
  const [enabled, setEnabled] = useState<Record<DomainSource, boolean>>({ semrush: true, ubersuggest: true, ahrefs: true });
  const [files, setFiles] = useState<Partial<Record<DomainSource, File>>>({});
  const [jobs, setJobs] = useState<Partial<Record<DomainSource, DomainFetchJob>>>({});
  const [mode, setMode] = useState<DomainReportMode>('combined');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<DomainReport[]>([]);
  const [fetchStatus, setFetchStatus] = useState<DomainFetchStatus | null>(null);
  const [compSearch, setCompSearch] = useState<DomainCompetitorSearch | null>(null);
  const [compDomains, setCompDomains] = useState<string[]>(() => Array(COMPETITOR_COUNT).fill(''));
  const [compJobs, setCompJobs] = useState<(DomainFetchJob | null)[]>(() => Array(COMPETITOR_COUNT).fill(null));

  const client =useMemo(() => clients.find((c) => c.id === clientId) ?? null, [clients, clientId]);
  const isAuto = (s: DomainSource) => !!fetchStatus?.automatic.includes(s);

  // Follow the header's client by default; the page can still pick another.
  useEffect(() => {
    if (activeClient && !clientId) setClientId(activeClient.id);
  }, [activeClient, clientId]);

  useEffect(() => {
    setWebsiteUrl(client?.domain ?? '');
    setFiles({});
    setError(null);
  }, [client?.id, client?.domain]);

  // A fetch is for one client + site + country -- changing any of them needs a new fetch.
  useEffect(() => {
    setJobs({});
    setCompSearch(null);
    setCompDomains(Array(COMPETITOR_COUNT).fill(''));
    setCompJobs(Array(COMPETITOR_COUNT).fill(null));
  }, [client?.id, websiteUrl, location]);

  // Follow "Find competitors" until Semrush's list is back, then pre-fill the top 3.
  const searchId = compSearch && (compSearch.state === 'queued' || compSearch.state === 'running') ? compSearch.id : null;
  useEffect(() => {
    if (!searchId) return;
    const t = window.setInterval(async () => {
      try {
        const s = await getCompetitorSearch(searchId);
        setCompSearch(s);
        if (s.state === 'done' && s.competitors) {
          setCompDomains(Array.from({ length: COMPETITOR_COUNT }, (_, i) => s.competitors![i]?.domain ?? ''));
          setCompJobs(Array(COMPETITOR_COUNT).fill(null));
        }
      } catch (err) {
        setError((err as Error).message);
      }
    }, 2500);
    return () => window.clearInterval(t);
  }, [searchId]);

  // Follow the competitors' Semrush fetches.
  const compRunningKey = compJobs.map((j) => (j && (j.state === 'queued' || j.state === 'fetching') ? j.id : '')).join(',');
  useEffect(() => {
    if (!compRunningKey.replace(/,/g, '')) return;
    const t = window.setInterval(async () => {
      for (const id of compRunningKey.split(',').filter(Boolean)) {
        try {
          const job = await getDomainFetch(id);
          setCompJobs((prev) => prev.map((j) => (j?.id === job.id ? job : j)));
        } catch (err) {
          setError((err as Error).message);
        }
      }
    }, 2500);
    return () => window.clearInterval(t);
  }, [compRunningKey]);

  const refreshFetchStatus = useCallback(() => {
    getDomainFetchStatus().then(setFetchStatus, () => {});
  }, []);

  useEffect(() => {
    refreshFetchStatus();
  }, [refreshFetchStatus]);

  const loadReports = useCallback(async () => {
    if (!clientId) return setReports([]);
    try {
      setReports(await getDomainReports(clientId));
    } catch {
      // history is secondary -- the form still works
    }
  }, [clientId]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  // Posting runs in the background on the server; refresh while any report is still in flight.
  const inFlight = reports.some((r) => r.status === 'GENERATED' || r.status === 'POSTING' || r.status === 'GENERATING');
  useEffect(() => {
    if (!inFlight) return;
    const t = window.setInterval(() => void loadReports(), 3000);
    return () => window.clearInterval(t);
  }, [inFlight, loadReports]);

  // Follow running fetches until they finish.
  const runningJobs = Object.values(jobs).filter((j) => j && (j.state === 'queued' || j.state === 'fetching')) as DomainFetchJob[];
  const runningKey = runningJobs.map((j) => j.id).join(',');
  useEffect(() => {
    if (!runningKey) return;
    const t = window.setInterval(async () => {
      for (const id of runningKey.split(',')) {
        try {
          const job = await getDomainFetch(id);
          setJobs((prev) => (prev[job.source]?.id === job.id ? { ...prev, [job.source]: job } : prev));
          if (job.state === 'done' || job.state === 'failed') refreshFetchStatus();
        } catch (err) {
          setError((err as Error).message);
        }
      }
    }, 2500);
    return () => window.clearInterval(t);
  }, [runningKey, refreshFetchStatus]);

  const chosen = SOURCES.filter((s) => enabled[s.value]);
  const hasData = (s: DomainSource) => !!files[s] || jobs[s]?.state === 'done';
  const missing = chosen.filter((s) => !hasData(s.value));
  const fetching = chosen.filter((s) => !files[s.value] && runningJobs.some((j) => j.source === s.value));
  const formReady = !!client && websiteUrl.trim().length > 0;
  const compFetching = compJobs.some((j) => j?.state === 'queued' || j?.state === 'fetching');
  const compProblems = competitorProblems(compDomains, websiteUrl);
  const ready = formReady && chosen.length > 0 && missing.length === 0 && !compFetching;

  async function handleFindCompetitors() {
    if (!client || !formReady) return;
    setError(null);
    try {
      setCompSearch(await startCompetitorSearch({ clientId: client.id, websiteUrl: websiteUrl.trim(), location }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleFetchCompetitors() {
    if (!client || !formReady || compProblems.some(Boolean)) return;
    setError(null);
    try {
      const started = await Promise.all(
        compDomains.map((d) => (toDomain(d) ? startDomainFetch({ source: 'semrush', clientId: client.id, websiteUrl: toDomain(d), location }) : Promise.resolve(null))),
      );
      setCompJobs(started);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleStartFetch(source: DomainSource) {
    if (!client || !formReady) return;
    setError(null);
    try {
      const job = await startDomainFetch({ source, clientId: client.id, websiteUrl: websiteUrl.trim(), location });
      setJobs((prev) => ({ ...prev, [source]: job }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCombine() {
    if (!ready || busy || !client) return;
    setBusy(true);
    setError(null);
    try {
      const picked = Object.fromEntries(chosen.filter((s) => files[s.value]).map((s) => [s.value, files[s.value]])) as Partial<Record<DomainSource, File>>;
      const fetched = Object.fromEntries(chosen.filter((s) => !files[s.value] && jobs[s.value]?.state === 'done').map((s) => [s.value, jobs[s.value]!.id]));
      const competitorFetches = compJobs.filter((j): j is DomainFetchJob => j?.state === 'done').map((j) => j.id);
      const report = await createDomainReport({ clientId: client.id, websiteUrl: websiteUrl.trim(), location, reportMode: mode, files: picked, fetched, competitorFetches });
      setReports((prev) => [report, ...prev.filter((r) => r.id !== report.id)]);
      setFiles({});
      setJobs({});
      setCompJobs(Array(COMPETITOR_COUNT).fill(null));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(reportId: string) {
    try {
      await retryDomainReportPost(reportId);
      await loadReports();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <AppShell>
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <GlobeIcon className="mt-0.5 h-6 w-6 text-[var(--color-ink)]" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)]">Domain Intelligence</h1>
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">Discover, consolidate and report domain keywords.</p>
            </div>
          </div>
          <span className="rounded-full bg-overlay/[0.08] px-3 py-1 text-xs font-semibold text-[var(--color-ink)]">New module</span>
        </div>

        {fetchStatus && (fetchStatus.loginProblem || (fetchStatus.mode === 'playwright' && !fetchStatus.sessionSaved)) && (
          <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">Flikover login expired — sign in again</p>
            <p className="mt-1 text-xs text-amber-200/80">
              {fetchStatus.loginProblem?.error ?? 'No saved Flikover login yet.'}{' '}
              {fetchStatus.mode === 'agent'
                ? 'Sign in to Flikover again in Chrome on the office computer, then fetch again.'
                : 'Ahrefs can’t be fetched automatically until someone signs in to Flikover once more (ask the dashboard admin).'}{' '}
              Until then, use “Upload the Ahrefs file instead”.
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-5">
          <FormField label="Client">
            <Select
              value={clientId}
              onChange={setClientId}
              placeholder="Select a client..."
              options={clients.map((c) => ({ value: c.id, label: c.name }))}
              searchable
            />
          </FormField>

          <FormField label="Website URL" htmlFor="di-url">
            <TextInput id="di-url" value={websiteUrl} placeholder="https://example.com.au" onChange={(e) => setWebsiteUrl(e.target.value)} disabled={busy} />
          </FormField>

          <FormField label="Location">
            <Select value={location} onChange={setLocation} placeholder="Select a country..." options={LOCATIONS} disabled={busy} />
          </FormField>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Data sources</p>
            <div className="flex flex-col gap-3">
              {SOURCES.map((s) => (
                <div key={s.value} className="flex flex-col gap-2">
                  <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink)]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-brand-500)]"
                      checked={enabled[s.value]}
                      disabled={busy}
                      onChange={(e) => setEnabled((prev) => ({ ...prev, [s.value]: e.target.checked }))}
                    />
                    {s.label}
                  </label>
                  {enabled[s.value] && (
                    <div className="pl-6.5">
                      {isAuto(s.value) ? (
                        <FetchSlot
                          label={s.label}
                          job={jobs[s.value] ?? null}
                          file={files[s.value] ?? null}
                          mock={!!fetchStatus && !fetchStatus.live}
                          agentNote={
                            fetchStatus?.mode === 'agent'
                              ? fetchStatus.agentOnline
                                ? 'Done by the office Chrome (online).'
                                : 'The office Chrome agent is OFFLINE — turn that computer and Chrome on, or upload the file instead.'
                              : undefined
                          }
                          canStart={formReady}
                          disabled={busy}
                          onStart={() => void handleStartFetch(s.value)}
                          onFile={(f) =>
                            setFiles((prev) => {
                              const next = { ...prev };
                              if (f) next[s.value] = f;
                              else delete next[s.value];
                              return next;
                            })
                          }
                        />
                      ) : (
                        <ExportDrop file={files[s.value] ?? null} onFile={(f) => setFiles((prev) => ({ ...prev, [s.value]: f }))} disabled={busy} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {enabled.semrush && isAuto('semrush') && (
            <CompetitorsSection
              search={compSearch}
              domains={compDomains}
              problems={compProblems}
              jobs={compJobs}
              canStart={formReady}
              disabled={busy}
              onFind={() => void handleFindCompetitors()}
              onDomain={(i, value) => {
                if (value === compDomains[i]) return;
                setCompDomains((prev) => prev.map((d, j) => (j === i ? value : d)));
                setCompJobs((prev) => prev.map((job, j) => (j === i ? null : job)));
              }}
              onPaste={(i, text) => {
                const filled = fillFromPaste(compDomains, i, text);
                if (!filled) return false;
                setCompDomains(filled);
                // A box whose website changed needs fetching again.
                setCompJobs((prev) => prev.map((job, j) => (filled[j] === compDomains[j] ? job : null)));
                return true;
              }}
              onFetch={() => void handleFetchCompetitors()}
            />
          )}

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Reports to generate</p>
            <div className="flex flex-col gap-2.5">
              {MODES.map((m) => (
                <label key={m.value} className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink)]">
                  <input
                    type="radio"
                    name="di-mode"
                    className="h-4 w-4 accent-[var(--color-brand-500)]"
                    checked={mode === m.value}
                    disabled={busy}
                    onChange={() => setMode(m.value)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          {client && (
            <p className={`text-xs ${client.domainReportTaskId ? 'text-[var(--color-ink-muted)]' : 'text-amber-300'}`}>
              {client.domainReportTaskId
                ? `Reports are posted as a comment on ClickUp task ${client.domainReportTaskId}.`
                : 'No domain-report ClickUp task is set for this client, so reports will be generated for download only. Add the task ID in Client Management.'}
            </p>
          )}

          <InlineError message={error} />

          <Button disabled={!ready || busy} onClick={() => void handleCombine()}>
            {busy ? (
              <>
                <Spinner /> Combining…
              </>
            ) : client?.domainReportTaskId ? (
              'Combine and post to ClickUp'
            ) : (
              'Combine reports'
            )}
          </Button>
          {!busy && client && chosen.length > 0 && missing.length > 0 && (
            <p className="-mt-3 text-center text-xs text-[var(--color-ink-faint)]">
              {fetching.length > 0 && `Waiting for ${fetching.map((s) => s.label).join(', ')} to finish fetching. `}
              {compFetching && 'Waiting for the competitors’ keywords. '}
              {missing.filter((s) => !fetching.includes(s)).length > 0 &&
                `Add the ${missing
                  .filter((s) => !fetching.includes(s))
                  .map((s) => s.label)
                  .join(', ')} file to continue.`}
            </p>
          )}
        </div>
      </Card>

      {client && (
        <Card className="mt-6 p-6">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Reports for {client.name}</h2>
          {reports.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-ink-faint)]">No domain reports yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {reports.map((r) => (
                <li key={r.id} className="rounded-2xl border border-[var(--color-border)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--color-ink)]">
                        {new Date(r.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        <span className="ml-2 font-normal text-[var(--color-ink-muted)]">{r.websiteUrl}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                        {sourceSummary(r)} keywords
                        {!!r.summary.competitors?.length && ` · vs ${r.summary.competitors.map((c) => c.domain).join(', ')}`}
                        {r.summary.intents &&
                          ` · ${Object.entries(r.summary.intents)
                            .filter(([, n]) => n > 0)
                            .map(([intent, n]) => `${intent} ${n}`)
                            .join(', ')}`}
                      </p>
                    </div>
                    <StatusBadge label={STATUS[r.status]?.label ?? r.status} toneClassName={STATUS[r.status]?.tone ?? ''} />
                  </div>
                  {r.error && r.status !== 'POSTED' && <p className="mt-2 text-xs text-amber-300">{r.error}</p>}
                  {!!r.summary.intentUnresolved && (
                    <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                      {r.summary.intentUnresolved} keyword(s) had no clear intent and were labelled Informational.
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {r.files.map((f, i) => (
                      <Button key={f.name} variant="secondary" className="!py-1.5 text-xs" onClick={() => void saveFile(r.id, i, f.name)}>
                        {f.name}
                      </Button>
                    ))}
                    {(r.status === 'POST_FAILED' || (r.status === 'NOT_POSTED' && client.domainReportTaskId)) && (
                      <Button variant="ghost" className="!py-1.5 text-xs" onClick={() => void handleRetry(r.id)}>
                        Post to ClickUp again
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </AppShell>
  );
}
