import type { ReactNode } from 'react';

const TONE_STYLES = {
  neutral: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
};

export function Badge({ tone, children, className = '' }: { tone: keyof typeof TONE_STYLES; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold tracking-wide ${TONE_STYLES[tone]} ${className}`.trim()}>
      {children}
    </span>
  );
}
