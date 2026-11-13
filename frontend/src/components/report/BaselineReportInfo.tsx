import { useEffect, useRef, useState } from 'react';
import { AlertPanel } from '../ui/AlertPanel';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { UploadIcon } from '../ui/icons';
import { fetchGoogleAdsVolumes, getReportBaselineInfo, getReportBaselineUrl, uploadKeywordPlannerFile } from '../../api/client';
import type { ReportBaselineInfo } from '../../api/types';

const ACCEPTED = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * "Baseline Report" (2026-11-10), for a new client's first report: what the Baseline Excel will contain, with a
 * download to check, and what's still missing. Volume/competition come from the team's Keyword Planner download
 * (uploaded here) -- or from the Google Ads API once it's set up on the server.
 */
export function BaselineReportInfo({ reportId, editable, className = '' }: { reportId: string; editable: boolean; className?: string }) {
  const [info, setInfo] = useState<ReportBaselineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'google' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInfo(null);
    setError(null);
    getReportBaselineInfo(reportId)
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [reportId]);

  async function run(kind: 'upload' | 'google', action: () => Promise<ReportBaselineInfo>) {
    setBusy(kind);
    setActionError(null);
    setSavedNote(null);
    try {
      const next = await action();
      setInfo(next);
      if (next.ready && next.saved !== undefined) setSavedNote(`Saved Keyword Planner numbers for ${next.saved} keyword${next.saved === 1 ? '' : 's'}.`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function handleFile(list: FileList | null) {
    const file = list?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (file) void run('upload', () => uploadKeywordPlannerFile(reportId, file));
  }

  if (error) return <p className={`text-sm text-rose-300 ${className}`}>Couldn't check the Baseline Report: {error}</p>;
  if (!info) {
    return (
      <div className={`flex items-center gap-2 text-sm text-[var(--color-ink-muted)] ${className}`}>
        <Spinner /> Building the Baseline Report...
      </div>
    );
  }
  if (!info.ready) {
    return (
      <AlertPanel tone="warning" className={className}>
        <p className="text-sm text-amber-300">{info.error}</p>
      </AlertPanel>
    );
  }

  const missing = info.missingVolumes.length;
  return (
    <AlertPanel tone={missing > 0 ? 'warning' : 'info'} className={className}>
      <p className="text-sm text-[var(--color-ink)]">
        This report sends the <span className="font-semibold">Baseline Report Excel</span> instead of the PDF: {info.keywordCount} keywords, ranks for{' '}
        <span className="font-semibold">{info.dateLabel}</span>, with search volume, competition, number of results, SERP result and intent.{' '}
        <a href={getReportBaselineUrl(reportId)} className="font-medium text-brand-300 hover:text-brand-200">
          Download to check
        </a>
      </p>
      {missing > 0 ? (
        <p className="mt-2 text-sm text-amber-300">
          No Keyword Planner numbers yet for {missing === info.keywordCount ? 'any keyword' : `${missing} keyword${missing === 1 ? '' : 's'}: ${info.missingVolumes.join(', ')}`}. Upload the Keyword Planner download
          {info.country ? ` (location: ${info.country === 'AU' ? 'Australia' : info.country === 'IN' ? 'India' : info.country === 'AE' ? 'UAE' : info.country})` : ''} -- otherwise these show
          "0 – 10" and "Unknown".
        </p>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Search volume and competition: {info.metricsSource === 'google_ads' ? 'Google Ads API' : 'Keyword Planner download'}.</p>
      )}
      {info.merged.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Keyword Planner merged these (same words, other order), so they use the merged figures: {info.merged.map((m) => `"${m.keyword}" uses "${m.usedFiguresOf}"`).join('; ')}.
        </p>
      )}
      {info.missingSerp.length > 0 && (
        <p className="mt-2 text-xs text-amber-300">
          The saved search results are gone for: {info.missingSerp.join(', ')} -- Number of Result and SERP result stay empty for them.
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--color-ink-faint)]">SERP result and Intent are worked out by rules from the search results -- check them in the download before sending.</p>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Number of Result can come out empty (Serper doesn't give it): fill it in the download by hand -- incognito Google search, Tools, the "About X results" number.</p>
      {editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input ref={inputRef} type="file" accept={ACCEPTED} className="hidden" onChange={(e) => handleFile(e.target.files)} />
          <Button variant="secondary" disabled={busy !== null} onClick={() => inputRef.current?.click()}>
            {busy === 'upload' ? <Spinner /> : <UploadIcon className="h-4 w-4" />}
            Upload Keyword Planner file
          </Button>
          {info.googleAdsAvailable && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => void run('google', () => fetchGoogleAdsVolumes(reportId))}>
              {busy === 'google' && <Spinner />}
              Get volumes from Google Ads
            </Button>
          )}
        </div>
      )}
      {savedNote && <p className="mt-2 text-xs text-emerald-300">{savedNote}</p>}
      {actionError && <p className="mt-2 text-sm text-rose-300">{actionError}</p>}
    </AlertPanel>
  );
}
