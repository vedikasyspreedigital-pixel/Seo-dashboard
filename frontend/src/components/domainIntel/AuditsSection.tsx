import { Button } from '../ui/Button';
import { StatusDot, type PartState } from './StatusDot';
import type { DomainAuditJob, DomainAuditKind } from '../../api/client';

// The three audits on their own (2026-10-26): run, follow, download, retry -- the same
// jobs "Run all 5 reports" uses, so its audits show here too.

const CARDS: { kind: DomainAuditKind; title: string; how: string }[] = [
  { kind: 'siteaudit', title: 'Semrush Site Audit', how: 'New Semrush project (1,000 pages) → crawl → Full Report PDF. About 8–10 min.' },
  { kind: 'woorank', title: 'WooRank Audit', how: 'Create Review → Refresh → Download PDF. About 3 min.' },
  { kind: 'aiaudit', title: 'AI SEO Audit', how: 'Gemini reads the latest WooRank + Site Audit → Excel in the team’s format. About 3–5 min.' },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function AuditsSection({
  audits,
  agentReady,
  canStart,
  disabled,
  onRun,
  onDownload,
}: {
  audits: Partial<Record<DomainAuditKind, DomainAuditJob>>;
  /** The office Chrome agent is set up on this server (agent mode). */
  agentReady: boolean;
  canStart: boolean;
  disabled: boolean;
  onRun: (kind: DomainAuditKind) => void;
  onDownload: (job: DomainAuditJob) => void;
}) {
  const sourceDone = audits.siteaudit?.state === 'done' || audits.woorank?.state === 'done';
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-[var(--color-ink-muted)]">Audits</p>
      <p className="mb-3 text-xs text-[var(--color-ink-faint)]">Run one audit on its own, or retry one that failed. Finished audits are kept for 7 days.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {CARDS.map(({ kind, title, how }) => {
          const job = audits[kind];
          const running = job?.state === 'queued' || job?.state === 'running';
          const needsAgent = kind !== 'aiaudit' && !agentReady;
          const needsSource = kind === 'aiaudit' && !sourceDone;
          const state: PartState = job ? job.state : 'idle';
          return (
            <div key={kind} className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusDot state={state} />
                <span className="font-semibold text-[var(--color-ink)]">{title}</span>
              </div>
              <p className="text-xs text-[var(--color-ink-faint)]">{how}</p>
              {running && <p className="text-xs text-brand-300">{job?.step ?? 'Working…'}</p>}
              {job?.state === 'done' && (
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Ready · {when(job.updatedAt)}
                  {job.sizeBytes ? ` · ${Math.max(1, Math.round(job.sizeBytes / 1024))} KB` : ''}
                </p>
              )}
              {job?.state === 'failed' && <p className="text-xs text-amber-300">{job.error}</p>}
              {needsAgent && <p className="text-xs text-amber-300">Needs the office Chrome agent (not set up on this server).</p>}
              {needsSource && !running && <p className="text-xs text-[var(--color-ink-faint)]">Run the Site Audit or WooRank first — this audit is built from them.</p>}
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                <Button variant="secondary" className="!py-1.5 text-xs" disabled={!canStart || disabled || running || needsAgent || needsSource} onClick={() => onRun(kind)}>
                  {job?.state === 'failed' ? 'Try again' : job ? 'Run again' : 'Run'}
                </Button>
                {job?.state === 'done' && (
                  <Button variant="ghost" className="!py-1.5 text-xs" onClick={() => onDownload(job)}>
                    Download
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
