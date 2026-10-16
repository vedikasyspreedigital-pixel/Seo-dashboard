import type { ReactNode } from 'react';

/**
 * Placeholder for an empty, loading, or failed list. `tone="error"` plus an
 * `action` (e.g. a Retry button) is what a failed load shows -- it must never
 * look like a genuinely empty list.
 */
export function EmptyState({ label, hint, tone = 'neutral', action }: { label: string; hint?: string; tone?: 'neutral' | 'error'; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className={`text-sm font-medium ${tone === 'error' ? 'text-rose-300' : 'text-[var(--color-ink-muted)]'}`}>{label}</p>
      {hint && <p className="max-w-md text-xs text-[var(--color-ink-faint)]">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Shimmering placeholder rows while a list loads (instead of a bare "Loading..."). */
export function LoadingRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-4 px-6 py-6" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="skeleton-bar h-3 w-20" />
          <div className="skeleton-bar h-3 flex-1" style={{ maxWidth: `${60 - i * 8}%` }} />
          <div className="skeleton-bar ml-auto h-5 w-24" />
        </div>
      ))}
    </div>
  );
}
