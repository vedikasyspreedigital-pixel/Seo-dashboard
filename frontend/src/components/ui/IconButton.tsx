import type { ReactNode } from 'react';

export function IconButton({ title, disabled, children }: { title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-muted)] opacity-60"
    >
      {children}
    </button>
  );
}
