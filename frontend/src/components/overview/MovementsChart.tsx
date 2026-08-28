import { Card } from '../ui/Card';
import type { OverviewData } from '../../api/types';

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;

function buildPath(values: number[], max: number): string {
  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = PAD_LEFT + stepX * i;
      const y = PAD_TOP + innerH - (max > 0 ? (v / max) * innerH : 0);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Real report-generation activity over time -- each point is an actual
 * day reports were generated, plotting real improved/declined/unchanged
 * keyword counts from computeRunAnalytics. No interpolated/estimated days:
 * if only 2-3 days have report data, only 2-3 points are drawn. */
export function MovementsChart({ data }: { data: OverviewData['dailyMovements'] }) {
  const hasData = data.length > 0;
  const max = Math.max(1, ...data.flatMap((d) => [d.improved, d.declined, d.unchanged]));
  const gridLines = 4;

  return (
    <Card className="flex h-full min-h-0 flex-col p-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brand-400" />
          <p className="text-[13px] font-semibold text-[var(--color-ink)]">Overall Reports</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--color-ink-muted)]">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> Ranking Increased
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" /> Ranking Decreased
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)]" /> No Change
          </span>
        </div>
      </div>

      {!hasData ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-ink-faint)]">
          No report activity yet -- this fills in as reports are generated.
        </div>
      ) : (
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-4 h-full min-h-0 w-full flex-1" preserveAspectRatio="none">
          <defs>
            <linearGradient id="movementsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(139,92,246,0.22)" />
              <stop offset="100%" stopColor="rgba(139,92,246,0)" />
            </linearGradient>
          </defs>

          {Array.from({ length: gridLines }).map((_, i) => {
            const y = PAD_TOP + ((HEIGHT - PAD_TOP - PAD_BOTTOM) / (gridLines - 1)) * i;
            return <line key={i} x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />;
          })}

          {data.length > 1 && (
            <path d={`${buildPath(data.map((d) => d.improved), max)} L${WIDTH - PAD_RIGHT},${HEIGHT - PAD_BOTTOM} L${PAD_LEFT},${HEIGHT - PAD_BOTTOM} Z`} fill="url(#movementsFill)" />
          )}

          <path d={buildPath(data.map((d) => d.unchanged), max)} fill="none" stroke="var(--color-ink-faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
          <path d={buildPath(data.map((d) => d.declined), max)} fill="none" stroke="#fb7185" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          <path d={buildPath(data.map((d) => d.improved), max)} fill="none" stroke="var(--color-brand-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {data.map((d, i) => {
            const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
            const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;
            const x = PAD_LEFT + stepX * i;
            const yFor = (v: number) => PAD_TOP + (HEIGHT - PAD_TOP - PAD_BOTTOM) - (max > 0 ? (v / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM) : 0);
            return (
              <g key={d.date}>
                <circle cx={x} cy={yFor(d.improved)} r="2.8" fill="var(--color-brand-400)" />
                <text x={x} y={HEIGHT - 8} textAnchor="middle" fontSize="10" fill="var(--color-ink-faint)">
                  {formatDay(d.date)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </Card>
  );
}
