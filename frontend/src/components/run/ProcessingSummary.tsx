import { ProgressBar } from './ProgressBar';
import type { RunProgress } from '../../api/types';

const TILES: { key: keyof Omit<RunProgress, 'runStatus'>; label: string; accent: string }[] = [
  { key: 'total', label: 'Total', accent: 'text-[var(--color-ink)]' },
  { key: 'pending', label: 'Pending', accent: 'text-[var(--color-ink)]' },
  { key: 'processing', label: 'Processing', accent: 'text-brand-300' },
  { key: 'completed', label: 'Completed', accent: 'text-[var(--color-ink)]' },
  { key: 'failed', label: 'Failed', accent: 'text-rose-300' },
];

/** Live "Processing N/Total rows -- X%" summary shown above the file-info
 * card while a run is in flight -- unboxed, floating directly on the page
 * background (matches the reference; the boxed StatTile treatment is only
 * for the terminal/completed summary). */
export function ProcessingSummary({ progress }: { progress: RunProgress }) {
  const numerator = progress.completed + progress.failed;
  const fraction = progress.total > 0 ? (numerator / progress.total) * 100 : 0;
  const percent = Math.round(fraction);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(139,92,246,0.6)]" />
          <span className="font-semibold text-brand-300">Processing</span>
          <span className="font-mono text-sm text-[var(--color-ink-faint)]">
            {numerator}/{progress.total} rows
          </span>
        </div>
        <span className="font-mono text-lg font-bold text-brand-300">{percent}%</span>
      </div>

      <div className="mt-3">
        <ProgressBar value={fraction} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5">
        {TILES.map((tile) => (
          <span key={tile.key} className="font-mono text-sm">
            <span className="mr-1.5 eyebrow-label">{tile.label}</span>
            <span className={`font-bold ${tile.accent}`}>{progress[tile.key]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
