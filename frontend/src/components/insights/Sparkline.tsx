/**
 * One keyword's rank over the history points (client view, 2026-11-23). Single series, so no legend: rank 1 at the
 * top, "Not in 100" drawn on the bottom edge as a hollow dot, gaps where the keyword wasn't tracked.
 */
export function Sparkline({ ranks, inPoint, width = 120, height = 28 }: { ranks: (number | null)[]; inPoint: boolean[]; width?: number; height?: number }) {
  const n = ranks.length;
  if (n === 0) return null;
  const pad = 3;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  // Log-ish scale so 1-10 movement is visible next to 50-100.
  const y = (rank: number | null) => {
    const r = rank === null ? 101 : Math.min(rank, 101);
    const t = Math.log(r) / Math.log(101);
    return pad + t * (height - 2 * pad);
  };
  const segments: string[] = [];
  let current = '';
  ranks.forEach((r, i) => {
    if (!inPoint[i]) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    current += `${current ? 'L' : 'M'}${x(i).toFixed(1)},${y(r).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIdx = inPoint.lastIndexOf(true);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Rank history: ${ranks.map((r, i) => (inPoint[i] ? (r ?? 'Not in 100') : '-')).join(', ')}`}>
      <line x1={pad} x2={width - pad} y1={y(10)} y2={y(10)} stroke="var(--color-border-strong)" strokeDasharray="2 3" />
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {lastIdx >= 0 && (
        <circle
          cx={x(lastIdx)}
          cy={y(ranks[lastIdx])}
          r={2.75}
          fill={ranks[lastIdx] === null ? 'var(--color-surface-2)' : 'var(--chart-1)'}
          stroke="var(--chart-1)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
