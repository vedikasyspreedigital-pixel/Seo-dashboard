import type { ReactNode } from 'react';

const TONE_STYLES = {
  info: 'border-[var(--color-border)] bg-[var(--color-surface-2)]',
  warning: 'border-amber-500/25 bg-amber-500/[0.06]',
};

export function AlertPanel({ tone, className = '', children }: { tone: keyof typeof TONE_STYLES; className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border p-4 ${TONE_STYLES[tone]} ${className}`.trim()}>{children}</div>;
}
