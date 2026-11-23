import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../ui/Card';
import { StatusBadge } from '../ui/StatusBadge';
import { getRunQueue } from '../../api/client';
import type { RunQueue } from '../../api/types';

const POLL_MS = 5000;

/**
 * The shared run queue (2026-11-23): what's checking now and what's waiting, for both teams, in order. The other
 * team's runs show as "<Team> run" (no client name). Urgent runs are marked, with the reason for your own team.
 */
export function RunQueueCard({ className = '' }: { className?: string }) {
  const [queue, setQueue] = useState<RunQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const data = await getRunQueue();
        if (cancelled) return;
        setQueue(data);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!queue && !error) return null;
  const entries = queue?.entries ?? [];
  const checking = entries.filter((e) => e.status === 'PROCESSING');
  const waiting = entries.filter((e) => e.status === 'QUEUED');
  const slots = queue?.concurrency === 0 ? 'no limit' : `${queue?.concurrency ?? 1} at a time`;

  return (
    <Card className={`p-0 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-4">
        <div>
          <p className="font-semibold text-[var(--color-ink)]">Run queue</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            Shared by both teams · {slots} · urgent runs go next, never interrupting one that's checking
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge label={`${checking.length} checking`} toneClassName="bg-blue-500/10 text-blue-300" />
          <StatusBadge label={`${waiting.length} waiting`} toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]" />
        </div>
      </div>
      {error && <p className="px-6 py-3 text-sm text-rose-300">Couldn't load the queue: {error}</p>}
      {entries.length === 0 ? (
        <p className="px-6 py-4 text-sm text-[var(--color-ink-faint)]">Nothing checking right now. A run you start begins straight away.</p>
      ) : (
        <ul>
          {entries.map((e) => {
            const own = e.clientName !== null;
            const label = own ? e.clientName : `${e.workspaceName ?? 'Other team'} run`;
            const pct = e.totalRows ? Math.round((e.doneRows / e.totalRows) * 100) : 0;
            return (
              <li key={e.runId} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] px-6 py-3 last:border-0">
                <span className="w-16 shrink-0">
                  {e.status === 'PROCESSING' ? (
                    <StatusBadge label="Now" toneClassName="bg-blue-500/10 text-blue-300" />
                  ) : (
                    <span className="font-mono text-sm text-[var(--color-ink-muted)]">#{e.position}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  {own ? (
                    <Link to={`/runs/${e.runId}`} className="font-medium text-[var(--color-ink)] hover:text-brand-200">
                      {label}
                    </Link>
                  ) : (
                    <span className="font-medium text-[var(--color-ink-muted)]">{label}</span>
                  )}
                  <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{e.workspaceName}</span>
                  {e.urgent && (
                    <span className="ml-2 align-middle" title={e.urgentReason ? `Urgent: ${e.urgentReason}${e.urgentBy ? ` (${e.urgentBy})` : ''}` : 'Urgent'}>
                      <StatusBadge label={e.urgentReason ? `Urgent · ${e.urgentReason}` : 'Urgent'} toneClassName="bg-rose-500/10 text-rose-300" size="sm" />
                    </span>
                  )}
                </span>
                <span className="w-40 shrink-0 text-right font-mono text-xs text-[var(--color-ink-muted)]">
                  {e.status === 'PROCESSING' ? (
                    <>
                      <span className="mr-2 inline-block h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-surface-3)] align-middle">
                        <span className="block h-full rounded-full bg-blue-400" style={{ width: `${pct}%` }} />
                      </span>
                      {e.doneRows}/{e.totalRows}
                    </>
                  ) : (
                    `${e.totalRows} keywords`
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
