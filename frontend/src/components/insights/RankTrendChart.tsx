import { useState } from 'react';
import type { ClientInsights } from '../../api/types';

const W = 720;
const H = 240;
const PAD = { left: 36, right: 96, top: 14, bottom: 28 };

const SERIES = [
  { key: 'top3', label: 'Top 3', color: 'var(--chart-1)' },
  { key: 'top10', label: 'Top 10', color: 'var(--chart-2)' },
  { key: 'top100', label: 'Top 100', color: 'var(--chart-3)' },
] as const;

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Keywords in the top 3 / 10 / 100 at each history point (client view, 2026-11-23). Colours are validated tokens
 * (--chart-1..3). Filled dots = verified ranks (a sent or imported report); a hollow dot = the latest check, not
 * verified yet. Hover shows the numbers; "Table" shows them all.
 */
export function RankTrendChart({ trend }: { trend: ClientInsights['trend'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const n = trend.length;
  const max = Math.max(1, ...trend.map((t) => t.total), ...trend.map((t) => t.top100));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, Math.round(max / 2), max];

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-semibold text-[var(--color-ink)]">Keywords ranking over time</p>
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          Each point is a sent report (verified ranks). A hollow point is the latest check, not verified yet.
        </p>
      </div>
      <div className="flex items-center gap-4 text-xs text-[var(--color-ink-muted)]">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-[3px] w-4 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <button type="button" onClick={() => setTable((t) => !t)} className="rounded-full border border-[var(--color-border)] px-2.5 py-1 font-medium hover:text-[var(--color-ink)]">
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
    </div>
  );

  if (n === 0) {
    return (
      <div>
        {header}
        <p className="mt-6 text-sm text-[var(--color-ink-faint)]">No ranks yet. They appear after the first report is sent or a previous ranking is uploaded.</p>
      </div>
    );
  }

  if (table) {
    return (
      <div>
        {header}
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="eyebrow-label border-b border-[var(--color-border)]">
              <th className="cell-compact">Date</th>
              <th className="cell-compact">Source</th>
              <th className="cell-compact text-right">Keywords</th>
              {SERIES.map((s) => (
                <th key={s.key} className="cell-compact text-right">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trend.map((t) => (
              <tr key={t.id} className="border-b border-[var(--color-border)] last:border-0">
                <td className="cell-cozy text-[var(--color-ink)]">{shortDate(t.date)}</td>
                <td className="cell-cozy text-[var(--color-ink-muted)]">{t.kind === 'baseline' ? 'Sent report' : 'Latest check'}</td>
                <td className="cell-cozy text-right font-mono">{t.total}</td>
                {SERIES.map((s) => (
                  <td key={s.key} className="cell-cozy text-right font-mono text-[var(--color-ink)]">
                    {t[s.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const last = trend[n - 1];
  // Direct end labels, nudged apart so they never overlap.
  const ends = SERIES.map((s) => ({ ...s, value: last[s.key], y: y(last[s.key]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;

  return (
    <div>
      {header}
      <div className="relative mt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Keywords in top 3, top 10 and top 100 over time" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-border)" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-ink-faint)">
                {t}
              </text>
            </g>
          ))}
          {trend.map((t, i) => (
            <text key={t.id} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-ink-faint)">
              {n <= 8 || i % Math.ceil(n / 8) === 0 || i === n - 1 ? shortDate(t.date) : ''}
            </text>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-border-strong)" />}
          {SERIES.map((s) => (
            <g key={s.key}>
              <path
                d={trend.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t[s.key]).toFixed(1)}`).join('')}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {trend.map((t, i) => (
                <circle
                  key={t.id}
                  cx={x(i)}
                  cy={y(t[s.key])}
                  r={hover === i ? 5 : 4}
                  fill={t.kind === 'run' ? 'var(--color-surface-2)' : s.color}
                  stroke={t.kind === 'run' ? s.color : 'var(--color-surface-2)'}
                  strokeWidth={2}
                />
              ))}
            </g>
          ))}
          {ends.map((e) => (
            <text key={e.key} x={x(n - 1) + 10} y={e.y + 4} fontSize={12} fill="var(--color-ink-muted)">
              <tspan fontWeight={700} fill="var(--color-ink)">
                {e.value}
              </tspan>{' '}
              {e.label}
            </text>
          ))}
          {/* Hover targets: one wide band per point. */}
          {trend.map((t, i) => (
            <rect
              key={t.id}
              x={x(i) - (n === 1 ? innerW / 2 : innerW / (n - 1) / 2)}
              y={PAD.top}
              width={n === 1 ? innerW : innerW / (n - 1)}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2 text-xs shadow-lg"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > n / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
          >
            <p className="font-semibold text-[var(--color-ink)]">
              {shortDate(trend[hover].date)} · {trend[hover].kind === 'baseline' ? 'sent report' : 'latest check'}
            </p>
            {SERIES.map((s) => (
              <p key={s.key} className="mt-1 flex items-center gap-2 text-[var(--color-ink-muted)]">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
                <span className="ml-auto pl-4 font-mono font-semibold text-[var(--color-ink)]">{trend[hover][s.key]}</span>
              </p>
            ))}
            <p className="mt-1 text-[var(--color-ink-faint)]">of {trend[hover].total} keywords</p>
          </div>
        )}
      </div>
    </div>
  );
}
