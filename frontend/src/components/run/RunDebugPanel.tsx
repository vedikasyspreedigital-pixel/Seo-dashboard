import { useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { getRunDebug, type RunDiagnostics } from '../../api/client';

// "Debug details" (2026-11-05): what DataForSEO answered for every keyword -- each try's status code, the
// result pages it crawled, how many results were Google redirect links (address hidden), and the URL that
// was counted as the client, flagged when it's another website. Loaded only when opened.

const pages = (n: number | null) => (n == null ? '–' : `${n}/10`);

export function RunDebugPanel({ runId }: { runId: string }) {
  const [data, setData] = useState<RunDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getRunDebug(runId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Tab-separated, so it pastes straight into Excel.
  async function copyForExcel() {
    if (!data) return;
    const header = ['Keyword', 'Final', 'Rank', 'Counted URL', 'Other website?', 'Page check', 'Readings (middle one used)', 'Tries (status codes)', 'Pages crawled (last try)', 'Redirect links (last try)', 'Last error'];
    const lines = data.rows.map((r) => {
      const last = r.attempts[r.attempts.length - 1];
      return [
        r.keyword,
        r.status,
        r.rank ?? '',
        r.rankingUrl ?? '',
        r.otherSite ? 'YES' : '',
        pageCheckLabel(r.pageCheck),
        r.readings ? r.readings.ranks.join(', ') : '',
        r.attempts.map((a) => a.statusCode ?? 'none').join(' → '),
        last?.pages ?? '',
        last && last.redirects != null && last.organic != null ? `${last.redirects}/${last.organic}` : '',
        (last?.error ?? '').replace(/\s+/g, ' '),
      ].join('\t');
    });
    await navigator.clipboard.writeText([header.join('\t'), ...lines].join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const s = data?.summary;
  return (
    <Card className="mt-6 p-0">
      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()}>
        <summary className="cursor-pointer px-6 py-4 text-sm font-semibold text-[var(--color-ink)]">
          Debug details <span className="font-normal text-[var(--color-ink-faint)]">— what DataForSEO answered for each keyword</span>
        </summary>
        <div className="px-6 pb-6">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Spinner /> Reading the saved answers…
            </p>
          )}
          {error && <p className="text-sm text-amber-300">{error}</p>}
          {data && s && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-[var(--color-ink-muted)]">
                <span>
                  Method: <strong className="text-[var(--color-ink)]">{data.engine === 'standard' ? 'Queue (Standard)' : data.engine === 'serper' ? 'Serper' : 'Live'}</strong>
                </span>
                <span>
                  {s.keywords} keywords · {s.tries} tries
                </span>
                <span className={s.otherSiteMatches ? 'text-amber-300' : ''}>Counted another website: {s.otherSiteMatches}</span>
                <span>Stopped early (“no results” before 10 pages): {s.earlyStops}</span>
                {s.organic > 0 && (
                  <span>
                    Google redirect links: {s.redirects}/{s.organic} ({Math.round((s.redirects / s.organic) * 100)}%)
                  </span>
                )}
                {!!s.converted && <span>Converted to real addresses: {s.converted}</span>}
                {!!s.pageCheck?.checked && (
                  <span title="Each results page is compared with the same keyword's page in the previous run. Fewer than half the usual websites = Google probably served a fake ('poisoned') page, so DataForSEO is asked once more.">
                    Pages checked against last run: {s.pageCheck.checked} · asked again: {s.pageCheck.reAsked} · really changed: {s.pageCheck.changed}
                    {' · '}
                    <span className={s.pageCheck.unconfirmed ? 'font-medium text-amber-300' : ''}>unconfirmed: {s.pageCheck.unconfirmed}</span>
                  </span>
                )}
                {s.rawGone > 0 && <span className="text-[var(--color-ink-faint)]">{s.rawGone} tries older than 40 days: no page details</span>}
              </div>

              <table className="mt-4 w-full max-w-xl text-left text-xs">
                <thead className="text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Status code</th>
                    <th className="py-1 pr-3 font-medium">Meaning</th>
                    <th className="py-1 pr-3 font-medium">Tries</th>
                    <th className="py-1 font-medium">Avg pages crawled</th>
                  </tr>
                </thead>
                <tbody className="text-[var(--color-ink)]">
                  {s.byStatusCode.map((c) => (
                    <tr key={String(c.code)} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-3 font-mono">{c.code ?? '—'}</td>
                      <td className="py-1 pr-3">{c.meaning}</td>
                      <td className="py-1 pr-3">{c.tries}</td>
                      <td className="py-1">{c.avgPages ?? '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-5 flex items-center justify-between gap-3">
                <p className="text-xs text-[var(--color-ink-faint)]">
                  Redirect links = results whose address Google hid; the client is matched by the breadcrumb when that happens. Only the
                  client's own website counts. (Live runs before 5 Nov 2026 only saved the results DataForSEO matched to the client.)
                </p>
                <Button variant="secondary" className="!py-1 text-xs" onClick={() => void copyForExcel()}>
                  {copied ? 'Copied' : 'Copy for Excel'}
                </Button>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-xs">
                  <thead className="text-[var(--color-ink-faint)]">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Keyword</th>
                      <th className="py-1.5 pr-3 font-medium">Rank</th>
                      <th className="py-1.5 pr-3 font-medium">Counted URL</th>
                      <th className="py-1.5 pr-3 font-medium">Tries (status code · pages · redirects)</th>
                      <th className="py-1.5 font-medium">Last error</th>
                    </tr>
                  </thead>
                  <tbody className="text-[var(--color-ink)]">
                    {data.rows.map((r, i) => {
                      const last = r.attempts[r.attempts.length - 1];
                      return (
                        <tr key={i} className="border-t border-[var(--color-border)] align-top">
                          <td className="py-1.5 pr-3">{r.keyword}</td>
                          <td className="py-1.5 pr-3 whitespace-nowrap">
                            {r.rank ?? (r.status === 'FAILED' ? 'Failed' : '—')}
                            {r.readings && r.readings.ranks.length > 1 && (
                              <div className="text-[11px] text-[var(--color-ink-faint)]" title="DataForSEO was asked several times; the middle rank is used (DataForSEO support's advice for keywords whose Google page keeps changing).">
                                readings: {r.readings.ranks.join(' · ')}
                              </div>
                            )}
                            {r.pageCheck && r.pageCheck.status !== 'ok' && r.pageCheck.status !== 'no_previous' && (
                              <div className={`text-[11px] ${r.pageCheck.status === 'suspect' ? 'font-medium text-amber-300' : 'text-[var(--color-ink-faint)]'}`}>{pageCheckLabel(r.pageCheck)}</div>
                            )}
                          </td>
                          <td className="max-w-[280px] break-all py-1.5 pr-3">
                            {r.rankingUrl ?? '—'}
                            {r.otherSite && <span className="ml-1 whitespace-nowrap font-medium text-amber-300">⚠ not {r.clientDomain}</span>}
                          </td>
                          <td className="py-1.5 pr-3 font-mono">
                            {r.attempts.length === 0
                              ? '—'
                              : r.attempts.map((a) => (
                                  <div key={a.attempt}>
                                    {a.statusCode ?? 'none'} · {pages(a.pages)}
                                    {a.redirects != null && a.organic ? ` · ${a.redirects}/${a.organic}` : ''}
                                  </div>
                                ))}
                          </td>
                          <td className="max-w-[260px] py-1.5 text-[var(--color-ink-muted)]">{last?.error ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

/** The poisoned-page check in the team's words. */
function pageCheckLabel(c: { status: string; share: number | null } | null | undefined): string {
  if (!c) return '';
  const pct = c.share != null ? ` (${Math.round(c.share * 100)}% of last run's sites)` : '';
  switch (c.status) {
    case 'ok':
      return `OK${pct}`;
    case 'ok_after_retry':
      return `First page looked fake, asked again: OK${pct}`;
    case 'changed':
      return `Google's page really changed (asked twice, same answer)${pct}`;
    case 'suspect':
      return `⚠ Unconfirmed: page didn't look right, even when asked again${pct}`;
    case 'no_previous':
      return 'No earlier run to compare';
    default:
      return c.status;
  }
}
