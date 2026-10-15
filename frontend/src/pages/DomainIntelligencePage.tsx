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
import {
  createDomainReport,
  downloadDomainReportFile,
  getDomainReports,
  retryDomainReportPost,
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
 * exports -> one combined and/or per-tool Excel with search intent, posted
 * automatically as a comment on the client's domain-report ClickUp task.
 */
export function DomainIntelligencePage() {
  const { clients, activeClient } = useActiveClient();
  const [clientId, setClientId] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [location, setLocation] = useState('au');
  // Backup path for when automatic fetching can't reach a tool: upload its export instead.
  const [manual, setManual] = useState(false);
  const [enabled, setEnabled] = useState<Record<DomainSource, boolean>>({ semrush: true, ubersuggest: true, ahrefs: true });
  const [files, setFiles] = useState<Partial<Record<DomainSource, File>>>({});
  const [mode, setMode] = useState<DomainReportMode>('combined');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<DomainReport[]>([]);

  const client = useMemo(() => clients.find((c) => c.id === clientId) ?? null, [clients, clientId]);

  // Follow the header's client by default; the page can still pick another.
  useEffect(() => {
    if (activeClient && !clientId) setClientId(activeClient.id);
  }, [activeClient, clientId]);

  useEffect(() => {
    setWebsiteUrl(client?.domain ?? '');
    setFiles({});
    setError(null);
  }, [client?.id, client?.domain]);

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

  const chosen = SOURCES.filter((s) => enabled[s.value]);
  const missing = chosen.filter((s) => !files[s.value]);
  const ready = manual && !!client && websiteUrl.trim().length > 0 && chosen.length > 0 && missing.length === 0;

  async function handleGenerate() {
    if (!ready || busy || !client) return;
    setBusy(true);
    setError(null);
    try {
      const picked = Object.fromEntries(chosen.map((s) => [s.value, files[s.value]])) as Partial<Record<DomainSource, File>>;
      const report = await createDomainReport({ clientId: client.id, websiteUrl: websiteUrl.trim(), location, reportMode: mode, files: picked });
      setReports((prev) => [report, ...prev.filter((r) => r.id !== report.id)]);
      setFiles({});
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
                  {manual && enabled[s.value] && (
                    <div className="pl-6.5">
                      <ExportDrop file={files[s.value] ?? null} onFile={(f) => setFiles((prev) => ({ ...prev, [s.value]: f }))} disabled={busy} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs font-medium text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
              onClick={() => setManual((m) => !m)}
              disabled={busy}
            >
              {manual ? 'Fetch automatically instead' : 'Upload exports manually instead'}
            </button>
          </div>

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
                ? `Reports are posted automatically as a comment on ClickUp task ${client.domainReportTaskId}.`
                : 'No domain-report ClickUp task is set for this client, so reports will be generated for download only. Add the task ID in Client Management.'}
            </p>
          )}

          <InlineError message={error} />

          {manual ? (
            <>
              <Button disabled={!ready || busy} onClick={() => void handleGenerate()}>
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
                <p className="-mt-3 text-center text-xs text-[var(--color-ink-faint)]">Upload the {missing.map((s) => s.label).join(', ')} export to continue.</p>
              )}
            </>
          ) : (
            <>
              {/* Automatic fetching (seotooladda / Flikover) is Phase 2 -- shown so the flow is clear, not yet clickable. */}
              <Button disabled>Fetch, combine and post to ClickUp</Button>
              <p className="-mt-3 text-center text-xs text-[var(--color-ink-faint)]">
                Automatic fetching from Semrush, Ubersuggest and Ahrefs is being connected. Until then, use “Upload exports manually instead”.
              </p>
            </>
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
