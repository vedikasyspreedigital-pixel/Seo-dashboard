import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useSession } from '../context/SessionContext';
import { competitorProblems, fillFromPaste, toDomain } from '../utils/competitorDomains';
import { RunAllPanel } from '../components/domainIntel/RunAllPanel';
import { bundleSelectionProblem } from '../utils/bundleSelection';
import { AuditsSection } from '../components/domainIntel/AuditsSection';
import {
  createDomainReport,
  downloadDomainAuditFile,
  downloadDomainReportFile,
  getDomainBundle,
  getDomainFetch,
  getDomainFetchStatus,
  getDomainHistory,
  getLatestDomainAudits,
  getMyDomainBundle,
  postDomainBundle,
  resolveDomainClient,
  retryDomainReportPost,
  startDomainAudit,
  startDomainBundle,
  startDomainFetch,
  DOMAIN_BUNDLE_REPORTS,
  type DomainBundleReport,
  type DomainAuditJob,
  type DomainAuditKind,
  type DomainBundle,
  type DomainClient,
  type DomainCompetitorSearch,
  type DomainFetchJob,
  type DomainHistoryReport as HistoryReport,
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
  { value: 'combined', label: 'Combined (all tools side by side)' },
  { value: 'individual', label: 'One file per tool' },
  { value: 'both', label: 'Both' },
];

const STATUS: Record<DomainReportStatus, { label: string; tone: string }> = {
  GENERATING: { label: 'Generating', tone: 'bg-overlay/[0.06] text-[var(--color-ink-muted)]' },
  GENERATED: { label: 'Waiting to post', tone: 'bg-overlay/[0.06] text-[var(--color-ink-muted)]' },
  POSTING: { label: 'Posting to ClickUp', tone: 'bg-brand-500/15 text-brand-300' },
  POSTED: { label: 'Posted to ClickUp', tone: 'bg-emerald-500/15 text-emerald-300' },
  POST_FAILED: { label: 'Post failed', tone: 'bg-rose-500/15 text-rose-300' },
  NOT_POSTED: { label: 'Not posted', tone: 'bg-amber-500/10 text-amber-300' },
  FAILED: { label: "Couldn't build the files", tone: 'bg-rose-500/15 text-rose-300' },
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
  showFetch = true,
  showFind = true,
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
  /** The per-competitor fetch status and "Fetch competitors' keywords" (the manual flow only). */
  showFetch?: boolean;
  /** The "Find competitors (Semrush)" button -- the page's "Find competitors for me" choice replaced it (2026-10-28). */
  showFind?: boolean;
}) {
  const searching = search?.state === 'queued' || search?.state === 'running';
  const anyRunning = jobs.some((j) => j?.state === 'queued' || j?.state === 'fetching');
  const filled = domains.filter((d) => d.trim()).length;
  const blocked = problems.some(Boolean);
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-ink-faint)]">
        Type or paste up to {COMPETITOR_COUNT} competitors’ websites (a full URL or a list works).
        They give the Keyword Analysis its side-by-side Competitors sheet and the Gap & Competitor report.
      </p>
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm">
        {showFind && <div className="flex flex-wrap items-center gap-3">
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
        </div>}
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
              {showFetch && (job?.state === 'queued' || job?.state === 'fetching') && (
                <span className="flex items-center gap-2 text-xs text-brand-300">
                  <Spinner /> {job.step ?? 'Fetching…'}
                </span>
              )}
              {showFetch && job?.state === 'done' && <span className="text-xs text-emerald-300">✓ {job.keywords} keywords</span>}
              {showFetch && job?.state === 'failed' && <span className="text-xs text-amber-300">{job.error}</span>}
            </div>
          );
        })}
        {showFetch && (
          <div>
            <Button variant="secondary" className="!py-1.5 text-xs" disabled={!canStart || disabled || anyRunning || filled === 0 || blocked} onClick={onFetch}>
              Fetch competitors’ keywords
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

async function saveFile(reportId: string, index: number, name: string) {
  saveBlob(await downloadDomainReportFile(reportId, index), name);
}

function saveBlob(blob: Blob, name: string) {
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

type CompetitorMode = 'find' | 'have';

/**
 * "Domain Intelligence": a client's Semrush / Ubersuggest / Ahrefs keyword exports + audits -> Excel/PDF
 * reports, posted as one comment on a ClickUp task. Since 2026-10-28 it's run for a new client almost every
 * time, so the client is TYPED (name, website, location, ClickUp task) instead of picked from the list; the
 * server keeps one hidden client per name behind it (resolveDomainClient).
 */
export function DomainIntelligencePage() {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?.id ?? null;
  const [clientName, setClientName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [location, setLocation] = useState('au');
  const [taskText, setTaskText] = useState('');
  const [competitorMode, setCompetitorMode] = useState<CompetitorMode>('find');
  const [enabled, setEnabled] = useState<Record<DomainSource, boolean>>({ semrush: true, ubersuggest: true, ahrefs: true });
  const [files, setFiles] = useState<Partial<Record<DomainSource, File>>>({});
  const [jobs, setJobs] = useState<Partial<Record<DomainSource, DomainFetchJob>>>({});
  const [mode, setMode] = useState<DomainReportMode>('combined');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryReport[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [fetchStatus, setFetchStatus] = useState<DomainFetchStatus | null>(null);
  const [compDomains, setCompDomains] = useState<string[]>(() => Array(COMPETITOR_COUNT).fill(''));
  const [compJobs, setCompJobs] = useState<(DomainFetchJob | null)[]>(() => Array(COMPETITOR_COUNT).fill(null));
  const [bundle, setBundle] = useState<DomainBundle | null>(null);
  const [bundleStarting, setBundleStarting] = useState(false);
  // The reports to make in the next run (all 5 by default; the team can untick some -- 2026-10-27).
  const [bundleReports, setBundleReports] = useState<DomainBundleReport[]>(DOMAIN_BUNDLE_REPORTS);
  const [postingReady, setPostingReady] = useState(false);
  const [audits, setAudits] = useState<Partial<Record<DomainAuditKind, DomainAuditJob>>>({});
  // "More options" (upload the files yourself); null = not touched yet.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  // The server's client for what's typed -- only valid while name, website and task are unchanged.
  const [resolved, setResolved] = useState<{ key: string; client: DomainClient } | null>(null);

  const clientKey = `${clientName.trim().toLowerCase()}|${websiteUrl.trim()}|${taskText.trim()}`;
  const client = resolved?.key === clientKey ? resolved.client : null;
  const isAuto = (s: DomainSource) => !!fetchStatus?.automatic.includes(s);
  const bundleRunning = bundle?.state === 'running';

  // Typing a different client: the previous one's run and audits leave the screen (not while a run is going --
  // the fields are locked then).
  function editIdentity(update: () => void) {
    update();
    if (!bundleRunning) setBundle(null);
    setError(null);
  }

  // A fetch is for one client + site + country -- changing any of them needs a new fetch.
  useEffect(() => {
    setJobs({});
    setCompJobs(Array(COMPETITOR_COUNT).fill(null));
  }, [clientName, websiteUrl, location]);

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

  // The workspace whose data is on screen: an answer for a workspace the user has since switched away from is dropped.
  const shownWorkspace = useRef(workspaceId);

  const loadHistory = useCallback(async () => {
    if (!workspaceId) return setHistory([]);
    try {
      const list = await getDomainHistory(workspaceId);
      if (shownWorkspace.current !== workspaceId) return;
      setHistory(list);
      setHistoryError(null);
    } catch (err) {
      // history is secondary -- the form still works, but say it didn't load
      if (shownWorkspace.current === workspaceId) setHistoryError((err as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // The typed client's latest audits -- they run on the server, so they're picked up again here.
  const clientId = client?.id ?? null;
  // An answer for a client the user has since typed away from is dropped.
  const shownClient = useRef(clientId);
  useEffect(() => {
    shownClient.current = clientId;
  }, [clientId]);
  const loadAudits = useCallback(async () => {
    if (!clientId) return setAudits({});
    try {
      const latest = await getLatestDomainAudits(clientId);
      if (shownClient.current === clientId) setAudits(latest);
    } catch {
      // the audit cards are secondary -- the form still works
    }
  }, [clientId]);

  useEffect(() => {
    void loadAudits();
  }, [loadAudits]);

  // Coming back to the page: this person's run that's still going (or just finished) shows again, with its form.
  useEffect(() => {
    shownWorkspace.current = workspaceId;
    setBundle(null);
    setHistory([]);
    setHistoryError(null);
    if (!workspaceId) return;
    getMyDomainBundle(workspaceId).then((b) => {
      if (!b || shownWorkspace.current !== workspaceId) return;
      const task = b.clickupTaskId ?? '';
      setClientName(b.clientName);
      setWebsiteUrl(b.websiteUrl);
      if (b.location) setLocation(b.location);
      setTaskText(task);
      setResolved({
        key: `${b.clientName.trim().toLowerCase()}|${b.websiteUrl.trim()}|${task}`,
        client: { id: b.clientId, name: b.clientName, domain: null, domainReportTaskId: b.clickupTaskId ?? null },
      });
      setBundle(b);
    }, () => {});
  }, [workspaceId]);

  // Follow a running "Run all" and running audits.
  const bundleId = bundle?.id ?? null;
  const auditsRunning = Object.values(audits).some((a) => a && (a.state === 'queued' || a.state === 'running'));
  useEffect(() => {
    if (!bundleRunning && !auditsRunning) return;
    const t = window.setInterval(async () => {
      try {
        await loadAudits();
        // Also after the run: an audit retried in the Audits section counts for the run (the server syncs it).
        if (bundleId) {
          const b = await getDomainBundle(bundleId);
          setBundle(b);
          if (b.state !== 'running') void loadHistory();
        }
      } catch (err) {
        setError((err as Error).message);
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [bundleId, bundleRunning, auditsRunning, loadAudits, loadHistory]);

  // Posting runs in the background on the server; refresh while any report is still in flight.
  const inFlight = history.some((r) => r.status === 'GENERATED' || r.status === 'POSTING' || r.status === 'GENERATING');
  useEffect(() => {
    if (!inFlight) return;
    const t = window.setInterval(() => void loadHistory(), 3000);
    return () => window.clearInterval(t);
  }, [inFlight, loadHistory]);

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
  const formReady = !!workspaceId && clientName.trim().length > 0 && websiteUrl.trim().length > 0;
  const compFetching = compJobs.some((j) => j?.state === 'queued' || j?.state === 'fetching');
  const haveCompetitors = competitorMode === 'have';
  const compProblems = haveCompetitors ? competitorProblems(compDomains, websiteUrl) : compDomains.map(() => null);
  const ready = formReady && chosen.length > 0 && missing.length === 0 && !compFetching;

  // "Run all": the ticked tools the office Chrome can fetch, and the typed competitors (or Semrush's top 3).
  const agentMode = fetchStatus?.mode === 'agent';
  const autoSources = chosen.filter((s) => isAuto(s.value)).map((s) => s.value);
  const typedCompetitors = haveCompetitors ? compDomains.map(toDomain).filter(Boolean) : [];
  const semrushOn = enabled.semrush && isAuto('semrush');
  const competitorNote = !semrushOn ? 'none (they need Semrush)' : haveCompetitors ? typedCompetitors.join(', ') || 'the ones you type' : 'Semrush’s top 3';
  // Keyword tools and competitors only matter for the Keyword Analysis and the Gap report.
  const needsKeywords = bundleReports.includes('keywords') || bundleReports.includes('gap');
  const bundleBlocked = !workspaceId
    ? 'No workspace selected.'
    : !clientName.trim()
      ? 'Enter the client’s name.'
      : !websiteUrl.trim()
        ? 'Enter the client’s website URL.'
        : bundleSelectionProblem(bundleReports)
          ? bundleSelectionProblem(bundleReports)
          : !agentMode
            ? 'Needs the office Chrome agent — this server isn’t set up for it yet.'
            : fetchStatus?.agentOnline === false
              ? 'The office Chrome agent is offline — turn that computer and Chrome on (the extension checks in every 30 seconds).'
              : needsKeywords && autoSources.length === 0
                ? 'Tick at least one keyword tool above.'
                : needsKeywords && semrushOn && haveCompetitors && typedCompetitors.length === 0
                  ? 'Type at least one competitor, or choose “Find competitors for me”.'
                  : needsKeywords && compProblems.some(Boolean)
                    ? 'Fix the competitor websites above first.'
                    : null;

  // Without the office Chrome, uploading the exports is the only way -- so that section opens by itself.
  const showManual = manualOpen ?? (!!fetchStatus && !agentMode);

  /** The server's client for the typed name (made the first time, reused after) -- every action starts here. */
  async function ensureClient(): Promise<DomainClient> {
    if (client) return client;
    const c = await resolveDomainClient({ workspaceId: workspaceId!, name: clientName, websiteUrl: websiteUrl.trim(), clickupTask: taskText });
    setResolved({ key: clientKey, client: c });
    return c;
  }

  async function handleRunAll() {
    if (bundleBlocked) return;
    setBundleStarting(true);
    setError(null);
    try {
      const c = await ensureClient();
      setBundle(
        await startDomainBundle({
          clientId: c.id,
          websiteUrl: websiteUrl.trim(),
          location,
          sources: autoSources,
          competitors: haveCompetitors ? typedCompetitors : 'auto',
          reportMode: mode,
          reports: bundleReports,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBundleStarting(false);
    }
  }

  async function handlePostReady() {
    if (!bundle?.reportId) return;
    setPostingReady(true);
    setError(null);
    try {
      setBundle(await postDomainBundle(bundle.id));
      await loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPostingReady(false);
    }
  }

  async function handleRunAudit(kind: DomainAuditKind) {
    if (!formReady) return;
    setError(null);
    try {
      const c = await ensureClient();
      const job = await startDomainAudit({ kind, clientId: c.id, websiteUrl: websiteUrl.trim() });
      setAudits((prev) => ({ ...prev, [kind]: job }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDownloadAudit(job: DomainAuditJob) {
    try {
      saveBlob(await downloadDomainAuditFile(job.id), job.fileName ?? `${job.kind}.pdf`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleFetchCompetitors() {
    if (!formReady || compProblems.some(Boolean)) return;
    setError(null);
    try {
      const c = await ensureClient();
      const started = await Promise.all(
        compDomains.map((d) => (toDomain(d) ? startDomainFetch({ source: 'semrush', clientId: c.id, websiteUrl: toDomain(d), location }) : Promise.resolve(null))),
      );
      setCompJobs(started);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleStartFetch(source: DomainSource) {
    if (!formReady) return;
    setError(null);
    try {
      const c = await ensureClient();
      const job = await startDomainFetch({ source, clientId: c.id, websiteUrl: websiteUrl.trim(), location });
      setJobs((prev) => ({ ...prev, [source]: job }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCombine() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await ensureClient();
      const picked = Object.fromEntries(chosen.filter((s) => files[s.value]).map((s) => [s.value, files[s.value]])) as Partial<Record<DomainSource, File>>;
      const fetched = Object.fromEntries(chosen.filter((s) => !files[s.value] && jobs[s.value]?.state === 'done').map((s) => [s.value, jobs[s.value]!.id]));
      const competitorFetches = compJobs.filter((j): j is DomainFetchJob => j?.state === 'done').map((j) => j.id);
      await createDomainReport({ clientId: c.id, websiteUrl: websiteUrl.trim(), location, reportMode: mode, files: picked, fetched, competitorFetches });
      await loadHistory();
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
      await loadHistory();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const needle = search.trim().toLowerCase();
  const shownHistory = needle ? history.filter((r) => r.clientName.toLowerCase().includes(needle) || r.websiteUrl.toLowerCase().includes(needle)) : history;
  const identityLocked = busy || bundleRunning || bundleStarting;

  return (
    <AppShell hideClientPicker>
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
          <FormField label="Client name" htmlFor="di-client">
            <TextInput
              id="di-client"
              value={clientName}
              placeholder="e.g. Sell Car For Cash"
              onChange={(e) => {
                const value = e.target.value;
                editIdentity(() => setClientName(value));
              }}
              disabled={identityLocked}
            />
          </FormField>

          <FormField label="Website URL" htmlFor="di-url">
            <TextInput
              id="di-url"
              value={websiteUrl}
              placeholder="https://example.com.au"
              onChange={(e) => {
                const value = e.target.value;
                editIdentity(() => {
                  setWebsiteUrl(value);
                  setCompDomains(Array(COMPETITOR_COUNT).fill(''));
                });
              }}
              disabled={identityLocked}
            />
          </FormField>

          <FormField label="Location">
            <Select value={location} onChange={setLocation} placeholder="Select a country..." options={LOCATIONS} disabled={identityLocked} />
          </FormField>

          <FormField label="ClickUp task ID or link" htmlFor="di-task">
            <TextInput
              id="di-task"
              value={taskText}
              placeholder="86c1abcde or https://app.clickup.com/t/86c1abcde"
              onChange={(e) => {
                const value = e.target.value;
                editIdentity(() => setTaskText(value));
              }}
              disabled={identityLocked}
            />
            <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
              {taskText.trim() ? 'The reports are posted as one comment on this task.' : 'Left empty, the reports are made for download only.'}
            </p>
          </FormField>

          {semrushOn ? (
            <div>
              <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Competitors</p>
              <div className="flex flex-wrap gap-x-6 gap-y-2" role="radiogroup" aria-label="Competitors">
                {(
                  [
                    { value: 'find', label: 'Find competitors for me (Semrush’s top 3)' },
                    { value: 'have', label: 'I have the competitors' },
                  ] as const
                ).map((o) => (
                  <label key={o.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink)]">
                    <input
                      type="radio"
                      name="di-competitors"
                      className="h-4 w-4 accent-[var(--color-brand-500)]"
                      checked={competitorMode === o.value}
                      disabled={busy || bundleRunning}
                      onChange={() => setCompetitorMode(o.value)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              {haveCompetitors && (
                <div className="mt-3">
                  <CompetitorsSection
                    search={null}
                    domains={compDomains}
                    problems={compProblems}
                    jobs={compJobs}
                    canStart={formReady}
                    disabled={busy || bundleRunning}
                    onFind={() => {}}
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
                    showFetch={false}
                    showFind={false}
                  />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-ink-faint)]">Competitors need Semrush — tick it below to compare against competitors.</p>
          )}

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Keyword tools</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {SOURCES.map((s) => (
                <label key={s.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--color-brand-500)]"
                    checked={enabled[s.value]}
                    disabled={busy || bundleRunning}
                    onChange={(e) => setEnabled((prev) => ({ ...prev, [s.value]: e.target.checked }))}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Keyword Analysis file</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {MODES.map((m) => (
                <label key={m.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink)]">
                  <input
                    type="radio"
                    name="di-mode"
                    className="h-4 w-4 accent-[var(--color-brand-500)]"
                    checked={mode === m.value}
                    disabled={busy || bundleRunning}
                    onChange={() => setMode(m.value)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          <details
            className="group rounded-2xl border border-[var(--color-border)] px-4 py-3"
            open={showManual}
            onToggle={(e) => setManualOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer select-none text-sm font-medium text-[var(--color-ink)]">
              More options — upload the files yourself
              <span className="ml-2 text-xs font-normal text-[var(--color-ink-faint)]">— keyword report only, no audits; use it when a tool’s file is uploaded by hand</span>
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              {chosen.length === 0 && <p className="text-xs text-[var(--color-ink-faint)]">Tick at least one keyword tool above.</p>}
              {SOURCES.filter((s) => enabled[s.value]).map((s) => (
                <div key={s.value} className="flex flex-col gap-2">
                  <p className="text-sm text-[var(--color-ink)]">{s.label}</p>
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
              ))}

              {semrushOn && typedCompetitors.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-[var(--color-ink)]">Competitors’ keywords (Semrush)</p>
                  <ul className="flex flex-col gap-1 text-xs">
                    {compDomains.map((d, i) => {
                      if (!toDomain(d)) return null;
                      const job = compJobs[i];
                      return (
                        <li key={i} className="flex flex-wrap items-center gap-2">
                          <span className="text-[var(--color-ink-muted)]">{toDomain(d)}</span>
                          {(job?.state === 'queued' || job?.state === 'fetching') && (
                            <span className="flex items-center gap-1.5 text-brand-300">
                              <Spinner className="h-3 w-3" /> {job.step ?? 'Fetching…'}
                            </span>
                          )}
                          {job?.state === 'done' && <span className="text-emerald-300">✓ {job.keywords} keywords</span>}
                          {job?.state === 'failed' && <span className="text-amber-300">{job.error}</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <div>
                    <Button
                      variant="secondary"
                      className="!py-1.5 text-xs"
                      disabled={!formReady || busy || compFetching || compProblems.some(Boolean)}
                      onClick={() => void handleFetchCompetitors()}
                    >
                      Fetch competitors’ keywords
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-col items-start gap-1.5">
                <Button variant="secondary" disabled={!ready || busy} onClick={() => void handleCombine()}>
                  {busy ? (
                    <>
                      <Spinner /> Combining…
                    </>
                  ) : taskText.trim() ? (
                    'Combine keywords and post to ClickUp'
                  ) : (
                    'Combine keywords'
                  )}
                </Button>
                {!busy && formReady && chosen.length > 0 && missing.length > 0 && (
                  <p className="text-xs text-[var(--color-ink-faint)]">
                    {fetching.length > 0 && `Waiting for ${fetching.map((s) => s.label).join(', ')} to finish fetching. `}
                    {compFetching && 'Waiting for the competitors’ keywords. '}
                    {missing.filter((s) => !fetching.includes(s)).length > 0 &&
                      `Fetch or upload the ${missing
                        .filter((s) => !fetching.includes(s))
                        .map((s) => s.label)
                        .join(', ')} file to continue.`}
                  </p>
                )}
              </div>
            </div>
          </details>

          <RunAllPanel
            bundle={bundle}
            selected={bundleReports}
            onSelectedChange={setBundleReports}
            blockedReason={bundleBlocked}
            starting={bundleStarting}
            competitorNote={competitorNote}
            onStart={() => void handleRunAll()}
            onPostReady={() => void handlePostReady()}
            posting={postingReady}
          />

          <InlineError message={error} />
        </div>
      </Card>

      <Card className="mt-6 p-6">
        <AuditsSection
          audits={audits}
          agentReady={agentMode}
          canStart={formReady}
          disabled={bundleRunning}
          onRun={(kind) => void handleRunAudit(kind)}
          onDownload={(job) => void handleDownloadAudit(job)}
        />
      </Card>

      <Card className="mt-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">History</h2>
          <div className="w-64 max-w-full">
            <TextInput value={search} placeholder="Search client or website…" aria-label="Search the history" onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {historyError && history.length === 0 ? (
          <p className="mt-3 text-sm text-rose-300">
            Couldn't load the history ({historyError}).{' '}
            <button type="button" className="underline" onClick={() => void loadHistory()}>
              Try again
            </button>
          </p>
        ) : shownHistory.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">{needle ? 'Nothing matches that search.' : 'No domain reports yet.'}</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {shownHistory.map((r) => (
              <li key={r.id} className="rounded-2xl border border-[var(--color-border)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--color-ink)]">
                      {r.clientName}
                      <span className="ml-2 font-normal text-[var(--color-ink-muted)]">{r.websiteUrl}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                      {new Date(r.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {' · '}
                      {r.summary.auditsOnly ? 'Audits only' : `${sourceSummary(r)} keywords`}
                      {!!r.summary.competitors?.length && ` · vs ${r.summary.competitors.map((c) => c.domain).join(', ')}`}
                      {r.summary.intents &&
                        ` · ${Object.entries(r.summary.intents)
                          .filter(([, n]) => n > 0)
                          .map(([intent, n]) => `${intent} ${n}`)
                          .join(', ')}`}
                    </p>
                  </div>
                  <StatusBadge
                    label={r.status === 'POSTED' && r.summary.mockPosted ? 'Test mode — not posted' : (STATUS[r.status]?.label ?? r.status)}
                    toneClassName={r.status === 'POSTED' && r.summary.mockPosted ? 'bg-amber-500/15 text-amber-300' : (STATUS[r.status]?.tone ?? '')}
                  />
                </div>
                {r.error && r.status !== 'POSTED' && <p className="mt-2 text-xs text-amber-300">{r.error}</p>}
                {!!r.summary.intentUnresolved && (
                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{r.summary.intentUnresolved} keyword(s) had no clear intent and were labelled Informational.</p>
                )}
                {r.summary.filesExpired && (
                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Files removed 10 days after posting to save space — they’re in the ClickUp comment.</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {r.files.map((f, i) => (
                    <Button key={f.name} variant="secondary" className="!py-1.5 text-xs" onClick={() => void saveFile(r.id, i, f.name)}>
                      {f.name}
                    </Button>
                  ))}
                  {(r.status === 'POST_FAILED' || (r.status === 'NOT_POSTED' && r.clientTaskId)) && (
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
    </AppShell>
  );
}
