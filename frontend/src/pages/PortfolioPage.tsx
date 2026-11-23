import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { FilterPills } from '../components/ui/FilterPills';
import { TextInput } from '../components/ui/TextInput';
import { EmptyState } from '../components/ui/EmptyState';
import { SortableTh, useSort } from '../components/ui/SortableTh';
import { useSession } from '../context/SessionContext';
import { getPortfolio } from '../api/client';
import type { Portfolio, PortfolioClient, ReportType } from '../api/types';

const REPORT_TYPE: Record<ReportType, { label: string; tone: string }> = {
  normal: { label: 'PDF', tone: 'bg-sky-500/15 text-sky-300' },
  consolidated: { label: 'Consolidated', tone: 'bg-violet-500/15 text-violet-300' },
  unconfirmed: { label: 'Not confirmed', tone: 'bg-amber-500/15 text-amber-300' },
};

const FILTERS = ['All', 'Report due', 'Declining', 'Running'] as const;
type Filter = (typeof FILTERS)[number];

function fmtShort(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';
}

function Count({ now, before }: { now: number | undefined; before: number | undefined }) {
  if (now === undefined) return <span className="text-[var(--color-ink-faint)]">—</span>;
  const d = before === undefined ? 0 : now - before;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono font-semibold text-[var(--color-ink)]">{now}</span>
      {d !== 0 && <span className={`font-mono text-xs ${d > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{d > 0 ? `+${d}` : d}</span>}
    </span>
  );
}

function Tile({ label, value, tone = 'text-[var(--color-ink)]', hint }: { label: string; value: number | string; tone?: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="eyebrow-label">{label}</p>
      <p className={`mt-2 font-mono text-[28px] font-bold leading-none tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{hint}</p>}
    </Card>
  );
}

/**
 * Portfolio (2026-11-23): every active client of the team on one screen -- where its keywords stand, which way
 * they moved since the report before, when its last report went and whether one is due.
 */
export function PortfolioPage() {
  const { activeWorkspace } = useSession();
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    setData(null);
    getPortfolio(activeWorkspace.id)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, attempt]);

  const clients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.clients ?? []).filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !(c.domain ?? '').toLowerCase().includes(q)) return false;
      if (filter === 'Report due') return c.reportDue;
      if (filter === 'Declining') return !!c.movement && c.movement.declined > c.movement.improved;
      if (filter === 'Running') return c.runningNow !== null;
      return true;
    });
  }, [data, filter, search]);

  const { sorted, sort, toggle } = useSort<PortfolioClient, 'name' | 'keywords' | 'top3' | 'top10' | 'top100' | 'net' | 'sent'>(
    clients,
    {
      name: (c) => c.name,
      keywords: (c) => c.latest?.total ?? null,
      top3: (c) => c.latest?.top3 ?? null,
      top10: (c) => c.latest?.top10 ?? null,
      top100: (c) => c.latest?.top100 ?? null,
      net: (c) => (c.movement ? c.movement.improved - c.movement.declined : null),
      sent: (c) => c.daysSinceSent ?? 9999,
    },
    { key: 'name', dir: 'asc' },
  );

  const totals = useMemo(() => {
    const list = data?.clients ?? [];
    return {
      clients: list.length,
      due: list.filter((c) => c.reportDue).length,
      top10: list.reduce((s, c) => s + (c.latest?.top10 ?? 0), 0),
      keywords: list.reduce((s, c) => s + (c.latest?.total ?? 0), 0),
      up: list.reduce((s, c) => s + (c.movement?.improved ?? 0), 0),
      down: list.reduce((s, c) => s + (c.movement?.declined ?? 0), 0),
    };
  }, [data]);

  return (
    <AppShell wide>
      <PageHeader breadcrumbs={[{ label: 'Portfolio' }]} />
      <PageTitle title="Portfolio" subtitle={activeWorkspace ? `${activeWorkspace.name} · every active client at a glance` : undefined} />

      {error && (
        <div className="mt-4">
          <EmptyState tone="error" label="Couldn't load the portfolio." hint={error} action={<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>} />
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Active clients" value={data ? totals.clients : '…'} />
        <Tile label="Reports due" value={data ? totals.due : '…'} tone={totals.due ? 'text-amber-300' : undefined} hint={data ? `no report sent in ${data.reportDueDays}+ days` : undefined} />
        <Tile label="Keywords in top 10" value={data ? totals.top10 : '…'} hint={data ? `of ${totals.keywords} tracked` : undefined} />
        <Tile label="Moved since last report" value={data ? `▲${totals.up}  ▼${totals.down}` : '…'} hint="keywords up / down, all clients" />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <FilterPills options={FILTERS} value={filter} onChange={setFilter} />
        <div className="w-64">
          <TextInput type="search" placeholder="Search clients..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <Card className="mt-4 overflow-hidden p-0">
        {!data && !error ? (
          <EmptyState label="Loading..." />
        ) : sorted.length === 0 ? (
          <EmptyState label={data?.clients.length ? 'No clients match.' : 'No active clients yet.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--color-surface-2)]">
                <tr className="eyebrow-label border-b border-[var(--color-border)]">
                  <SortableTh label="Client" sortKey="name" sort={sort} onSort={toggle} />
                  <th className="cell-compact">Report</th>
                  <SortableTh label="Keywords" sortKey="keywords" sort={sort} onSort={toggle} firstDir="desc" align="right" />
                  <SortableTh label="Top 3" sortKey="top3" sort={sort} onSort={toggle} firstDir="desc" align="right" />
                  <SortableTh label="Top 10" sortKey="top10" sort={sort} onSort={toggle} firstDir="desc" align="right" />
                  <SortableTh label="Top 100" sortKey="top100" sort={sort} onSort={toggle} firstDir="desc" align="right" />
                  <SortableTh label="Up / down" sortKey="net" sort={sort} onSort={toggle} firstDir="desc" align="right" />
                  <SortableTh label="Last sent" sortKey="sent" sort={sort} onSort={toggle} firstDir="desc" />
                  <th className="cell-compact">Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => {
                  const type = REPORT_TYPE[c.reportType];
                  return (
                    <tr key={c.clientId} className="border-b border-[var(--color-border)] last:border-0 hover:bg-overlay/[0.02]">
                      <td className="cell-cozy">
                        <Link to={`/clients/${c.clientId}`} className="font-medium text-[var(--color-ink)] hover:text-brand-200">
                          {c.name}
                        </Link>
                        {c.domain && <span className="block text-xs text-[var(--color-ink-faint)]">{c.domain}</span>}
                      </td>
                      <td className="cell-cozy">
                        <StatusBadge label={type.label} toneClassName={type.tone} size="sm" />
                      </td>
                      <td className="cell-cozy text-right font-mono text-[var(--color-ink-muted)]">{c.latest?.total ?? '—'}</td>
                      <td className="cell-cozy text-right">
                        <Count now={c.latest?.top3} before={c.previous?.top3} />
                      </td>
                      <td className="cell-cozy text-right">
                        <Count now={c.latest?.top10} before={c.previous?.top10} />
                      </td>
                      <td className="cell-cozy text-right">
                        <Count now={c.latest?.top100} before={c.previous?.top100} />
                      </td>
                      <td className="cell-cozy text-right font-mono text-xs">
                        {c.movement ? (
                          <>
                            <span className="text-emerald-300">▲{c.movement.improved}</span> <span className="text-rose-300">▼{c.movement.declined}</span>
                          </>
                        ) : (
                          <span className="text-[var(--color-ink-faint)]">—</span>
                        )}
                      </td>
                      <td className="cell-cozy text-[var(--color-ink-muted)]">
                        {c.lastSentAt ? (
                          <>
                            {fmtShort(c.lastSentAt)}
                            <span className="ml-1 text-xs text-[var(--color-ink-faint)]">({c.daysSinceSent}d)</span>
                          </>
                        ) : (
                          'Never'
                        )}
                      </td>
                      <td className="cell-cozy">
                        <div className="flex flex-wrap gap-1.5">
                          {c.runningNow && <StatusBadge label={c.runningNow === 'PROCESSING' ? 'Running' : 'Queued'} toneClassName="bg-blue-500/10 text-blue-300" size="sm" />}
                          {c.reportDue && <StatusBadge label="Report due" toneClassName="bg-amber-500/15 text-amber-300" size="sm" />}
                          {c.nextSlotAt && <StatusBadge label={`Slot ${fmtShort(c.nextSlotAt)}`} toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]" size="sm" dot={false} />}
                          {c.latestKind === 'run' && <StatusBadge label="Ranks not verified" toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]" size="sm" dot={false} />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
