import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { FilterPills } from '../components/ui/FilterPills';
import { EmptyState } from '../components/ui/EmptyState';
import { SortableTh, useSort } from '../components/ui/SortableTh';
import { StatusBadge as RunStatusBadge } from '../components/run/StatusBadge';
import { RankTrendChart } from '../components/insights/RankTrendChart';
import { Sparkline } from '../components/insights/Sparkline';
import { getClientInsights } from '../api/client';
import type { ClientInsights, ReportType } from '../api/types';

const REPORT_TYPE: Record<ReportType, { label: string; tone: string }> = {
  normal: { label: 'PDF report', tone: 'bg-sky-500/15 text-sky-300' },
  consolidated: { label: 'Consolidated', tone: 'bg-violet-500/15 text-violet-300' },
  unconfirmed: { label: 'Report type not confirmed', tone: 'bg-amber-500/15 text-amber-300' },
};

const FILTERS = ['All', 'Improved', 'Declined', 'Top 10', 'Not in 100'] as const;
type Filter = (typeof FILTERS)[number];

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}
function daysAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
/** Places gained (positive) between two ranks; "Not in 100" counts as 101. */
function gained(prev: number | null, latest: number | null) {
  return (prev ?? 101) - (latest ?? 101);
}

function Delta({ now, before }: { now: number; before: number | null | undefined }) {
  if (before === null || before === undefined) return <span className="text-[var(--color-ink-faint)]">no earlier report</span>;
  const d = now - before;
  if (d === 0) return <span className="text-[var(--color-ink-faint)]">same as before</span>;
  return (
    <span className={d > 0 ? 'text-emerald-300' : 'text-rose-300'}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d)} <span className="text-[var(--color-ink-faint)]">vs before ({before})</span>
    </span>
  );
}

function Metric({ label, value, caption }: { label: string; value: string | number; caption?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="eyebrow-label">{label}</p>
      <p className="mt-2 font-mono text-[28px] font-bold leading-none tabular-nums text-[var(--color-ink)]">{value}</p>
      {caption && <p className="mt-2 text-xs">{caption}</p>}
    </Card>
  );
}

/**
 * Client view (2026-11-23): one page per client -- ranks over time (from sent reports + the latest check), every
 * keyword's history, reports and baselines, what's running and when it runs next.
 */
export function ClientViewPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const [data, setData] = useState<ClientInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>('All');

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    getClientInsights(clientId)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [clientId, attempt]);

  const keywords = useMemo(() => {
    const all = data?.keywords ?? [];
    return all.filter((k) => {
      if (filter === 'Improved') return k.hadPrevious && gained(k.previous, k.latest) > 0;
      if (filter === 'Declined') return k.hadPrevious && gained(k.previous, k.latest) < 0;
      if (filter === 'Top 10') return k.latest !== null && k.latest <= 10;
      if (filter === 'Not in 100') return k.latest === null;
      return true;
    });
  }, [data, filter]);

  const { sorted, sort, toggle } = useSort<ClientInsights['keywords'][number], 'keyword' | 'latest' | 'previous' | 'change'>(
    keywords,
    {
      keyword: (k) => k.keyword,
      latest: (k) => k.latest ?? 101,
      previous: (k) => (k.hadPrevious ? (k.previous ?? 101) : null),
      change: (k) => (k.hadPrevious ? -gained(k.previous, k.latest) : null),
    },
    { key: 'latest', dir: 'asc' },
  );

  if (error) {
    return (
      <AppShell wide>
        <PageHeader breadcrumbs={[{ label: 'Clients', to: '/portfolio' }, { label: '...' }]} />
        <EmptyState tone="error" label="Couldn't load this client." hint={error} action={<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>} />
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell wide>
        <PageHeader breadcrumbs={[{ label: 'Clients', to: '/portfolio' }, { label: '...' }]} />
        <EmptyState label="Loading..." />
      </AppShell>
    );
  }

  const { client, latest, previous, movement } = data;
  const type = REPORT_TYPE[client.reportType];

  return (
    <AppShell wide>
      <PageHeader
        breadcrumbs={[{ label: 'Portfolio', to: '/portfolio' }, { label: client.name }]}
        action={
          <div className="flex items-center gap-2">
            <Link to={`/clients?reportSettings=${client.id}`}>
              <Button variant="secondary">Report settings</Button>
            </Link>
            <Link to="/run-slots">
              <Button variant="secondary">Run slots</Button>
            </Link>
          </div>
        }
      />

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--color-ink)]">{client.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-ink-muted)]">
            {client.domain && <span className="font-mono">{client.domain}</span>}
            <StatusBadge label={type.label} toneClassName={type.tone} />
            {!client.isActive && <StatusBadge label="Inactive" toneClassName="bg-amber-500/10 text-amber-300" />}
          </div>
        </div>
        <div className="flex flex-wrap gap-6 text-right text-sm">
          <div>
            <p className="eyebrow-label">Last report sent</p>
            <p className="mt-1 text-[var(--color-ink)]">{data.lastSent ? `${fmtDate(data.lastSent.sentAt)} · ${daysAgo(data.lastSent.sentAt)}` : 'Not yet'}</p>
          </div>
          <div>
            <p className="eyebrow-label">Next run slot</p>
            <p className="mt-1 text-[var(--color-ink)]">
              {data.nextSlot ? new Date(data.nextSlot.startsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'None booked'}
            </p>
          </div>
          {data.openRun && (
            <div>
              <p className="eyebrow-label">Current run</p>
              <Link to={`/runs/${data.openRun.id}`} className="mt-1 inline-block">
                <RunStatusBadge status={data.openRun.status} />
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric label="Keywords tracked" value={latest?.total ?? 0} caption={latest ? <span className="text-[var(--color-ink-faint)]">as of {fmtDate(latest.date)}{latest.kind === 'run' ? ' (latest check)' : ''}</span> : undefined} />
        <Metric label="Top 3" value={latest?.top3 ?? 0} caption={latest && <Delta now={latest.top3} before={previous?.top3} />} />
        <Metric label="Top 10" value={latest?.top10 ?? 0} caption={latest && <Delta now={latest.top10} before={previous?.top10} />} />
        <Metric label="Top 100" value={latest?.top100 ?? 0} caption={latest && <Delta now={latest.top100} before={previous?.top100} />} />
      </div>

      <Card className="mt-6 p-6">
        <RankTrendChart trend={data.trend} />
      </Card>

      <Card className="mt-6 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-4">
          <div>
            <p className="font-semibold text-[var(--color-ink)]">Keywords</p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
              {movement
                ? `Since ${fmtDate(previous?.date)}: ${movement.improved} up, ${movement.declined} down, ${movement.unchanged} same.`
                : 'Movement shows once there are two reports to compare.'}
            </p>
          </div>
          <FilterPills options={FILTERS} value={filter} onChange={setFilter} />
        </div>
        {sorted.length === 0 ? (
          <EmptyState label={data.keywords.length ? 'No keywords match this filter.' : 'No keywords yet.'} />
        ) : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--color-surface-2)]">
                <tr className="eyebrow-label border-b border-[var(--color-border)]">
                  <SortableTh label="Keyword" sortKey="keyword" sort={sort} onSort={toggle} />
                  <th className="cell-compact">Trend</th>
                  <SortableTh label="Previous" sortKey="previous" sort={sort} onSort={toggle} align="right" />
                  <SortableTh label="Now" sortKey="latest" sort={sort} onSort={toggle} align="right" />
                  <SortableTh label="Change" sortKey="change" sort={sort} onSort={toggle} align="right" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((k) => {
                  const g = k.hadPrevious ? gained(k.previous, k.latest) : null;
                  return (
                    <tr key={k.keyword} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="cell-cozy text-[var(--color-ink)]">{k.keyword}</td>
                      <td className="cell-cozy">
                        <Sparkline ranks={k.ranks} inPoint={k.inPoint} />
                      </td>
                      <td className="cell-cozy text-right font-mono text-[var(--color-ink-muted)]">{k.hadPrevious ? (k.previous ?? 'Not in 100') : '—'}</td>
                      <td className="cell-cozy text-right font-mono font-semibold text-[var(--color-ink)]">{k.latest ?? 'Not in 100'}</td>
                      <td className={`cell-cozy text-right font-mono ${g === null ? 'text-[var(--color-ink-faint)]' : g > 0 ? 'text-emerald-300' : g < 0 ? 'text-rose-300' : 'text-[var(--color-ink-faint)]'}`}>
                        {g === null
                          ? 'New'
                          : g === 0
                            ? '—'
                            : k.previous === null
                              ? '▲ Entered top 100'
                              : k.latest === null
                                ? '▼ Dropped out'
                                : `${g > 0 ? '▲' : '▼'} ${Math.abs(g)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <p className="border-b border-[var(--color-border)] px-6 py-4 font-semibold text-[var(--color-ink)]">Reports</p>
          {data.reports.length === 0 ? (
            <EmptyState label="No reports yet." />
          ) : (
            <ul>
              {data.reports.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3 text-sm last:border-0">
                  <Link to={`/reports/${r.id}/preview`} className="text-[var(--color-ink)] hover:text-brand-200">
                    {fmtDate(r.reportDate ?? r.createdAt)}
                    <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{r.attachment === 'baseline' ? 'Baseline Report' : r.attachment === 'generated' ? 'Ranking report' : r.attachment}</span>
                  </Link>
                  {r.sentAt ? (
                    <StatusBadge label={`Sent ${fmtDate(r.sentAt)}${r.sentManually ? ' (by hand)' : ''}`} toneClassName="bg-emerald-500/15 text-emerald-300" />
                  ) : (
                    <StatusBadge label={r.status.replace(/_/g, ' ').toLowerCase()} toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-0">
          <p className="border-b border-[var(--color-border)] px-6 py-4 font-semibold text-[var(--color-ink)]">Baselines (verified ranks)</p>
          {data.baselines.length === 0 ? (
            <EmptyState label="No baseline yet." hint="Upload the last report sent to this client in Client Management → Upload Previous Ranking." />
          ) : (
            <ul>
              {data.baselines.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3 text-sm last:border-0">
                  <span className="text-[var(--color-ink)]">
                    {fmtDate(b.baselineDate)}
                    <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{b.keywords} keywords</span>
                  </span>
                  <span className="truncate text-xs text-[var(--color-ink-faint)]" title={b.sourceFilename}>
                    {b.fromRun ? 'from a sent report' : `uploaded · ${b.sourceFilename}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
