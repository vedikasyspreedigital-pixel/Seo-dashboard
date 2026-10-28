import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { StatusDot } from './StatusDot';
import { DOMAIN_BUNDLE_REPORTS, type DomainBundle, type DomainBundlePart, type DomainBundleReport } from '../../api/client';

// "Run all 5 reports" (2026-10-26): one button, the run happens on the server, and
// each report's progress shows here -- also after leaving and coming back.
// Since 2026-10-27 the team ticks which reports to make (all 5 by default).

const ROWS: { part: DomainBundlePart; label: string }[] = [
  { part: 'keywords', label: '1. Keyword Analysis' },
  { part: 'siteaudit', label: '2. Semrush Site Audit' },
  { part: 'woorank', label: '3. WooRank Audit' },
  { part: 'gap', label: '4. Gap & Competitor Analysis' },
  { part: 'aiaudit', label: '5. AI SEO Audit' },
  { part: 'post', label: 'One ClickUp comment with every file' },
];

export function RunAllPanel({
  bundle,
  selected,
  onSelectedChange,
  blockedReason,
  starting,
  competitorNote,
  onStart,
  onPostReady,
  posting,
}: {
  bundle: DomainBundle | null;
  /** The reports ticked for the next run. */
  selected: DomainBundleReport[];
  onSelectedChange: (next: DomainBundleReport[]) => void;
  /** Why the run can't start right now (null = it can). */
  blockedReason: string | null;
  starting: boolean;
  /** What will be used for competitors, e.g. "Semrush's top 3" or the typed ones. */
  competitorNote: string;
  onStart: () => void;
  onPostReady: () => void;
  posting: boolean;
}) {
  const running = bundle?.state === 'running';
  const canPostReady = bundle && bundle.state === 'attention' && bundle.reportId && (bundle.parts.post.state === 'waiting' || bundle.parts.post.state === 'failed');
  // The run's own picks (older runs: all 5).
  const runPicked = bundle?.selected ?? DOMAIN_BUNDLE_REPORTS;
  const allReady = !!bundle && runPicked.every((p) => bundle.parts[p].state === 'done' || (p === 'gap' && bundle.parts.gap.state === 'skipped'));
  const all = selected.length === DOMAIN_BUNDLE_REPORTS.length;
  const toggle = (part: DomainBundleReport) =>
    onSelectedChange(selected.includes(part) ? selected.filter((p) => p !== part) : DOMAIN_BUNDLE_REPORTS.filter((p) => p === part || selected.includes(p)));
  const label = all ? 'Run all 5 reports' : `Run ${selected.length} selected report${selected.length === 1 ? '' : 's'}`;
  return (
    <div className="rounded-2xl border border-brand-500/30 bg-brand-500/[0.06] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Run the reports</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Tick the reports you want. Keywords come from the tools ticked above, competitors: {competitorNote}. All 5 take about 20–30 minutes. It runs on the
            server, so you can close this page.
          </p>
        </div>
        <Button disabled={!!blockedReason || running || starting} onClick={onStart}>
          {starting ? (
            <>
              <Spinner /> Starting…
            </>
          ) : running ? (
            'Running…'
          ) : (
            label
          )}
        </Button>
      </div>

      {!running && (
        <fieldset className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Reports to make">
          {ROWS.filter((r): r is { part: DomainBundleReport; label: string } => r.part !== 'post').map(({ part, label: rowLabel }) => (
            <label key={part} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-ink)]">
              <input type="checkbox" className="accent-brand-500" checked={selected.includes(part)} disabled={starting} onChange={() => toggle(part)} />
              {rowLabel.replace(/^\d\. /, '')}
            </label>
          ))}
        </fieldset>
      )}
      {selected.includes('gap') && !selected.includes('keywords') && !running && (
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">The Gap report is built from the keyword data — it’s fetched, but only the Gap file is posted.</p>
      )}
      {blockedReason && !running && <p className="mt-2 text-xs text-amber-300">{blockedReason}</p>}

      {bundle && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Run progress">
          {ROWS.filter(({ part }) => part === 'post' || runPicked.includes(part)).map(({ part, label: rowLabel }) => {
            const p = bundle.parts[part];
            return (
              <li key={part} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5">
                  <StatusDot state={p.state} />
                </span>
                <div className="min-w-0">
                  <span className={p.state === 'skipped' ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-ink)]'}>{rowLabel}</span>
                  {(p.error || p.step) && (
                    <p className={`truncate text-xs ${p.error ? 'text-amber-300' : 'text-[var(--color-ink-muted)]'}`} title={p.error ?? p.step}>
                      {p.error ?? p.step}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {bundle && bundle.competitors.length > 0 && <p className="mt-3 text-xs text-[var(--color-ink-faint)]">Competitors: {bundle.competitors.join(', ')}</p>}
      {bundle?.state === 'done' && <p className="mt-3 text-xs text-emerald-300">All reports are ready — the files are in the history below.</p>}
      {canPostReady && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant={allReady ? 'primary' : 'secondary'} className="!py-1.5 text-xs" disabled={posting} onClick={onPostReady}>
            {posting ? 'Posting…' : allReady ? 'Post the files to ClickUp' : 'Post the ready files to ClickUp'}
          </Button>
          {!allReady && <span className="text-xs text-[var(--color-ink-faint)]">Or retry the failed audit in the Audits section below — it’s picked up here when it finishes.</span>}
        </div>
      )}
    </div>
  );
}
