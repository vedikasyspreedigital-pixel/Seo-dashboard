import type { ReactNode } from 'react';

export function IconButton({
  title,
  disabled,
  onClick,
  badge = false,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  /** Small unread-style dot rendered top-right of the icon. */
  badge?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-muted)] transition-colors ${
        disabled ? 'opacity-60' : 'hover:border-white/[0.12] hover:text-[var(--color-ink)]'
      }`}
    >
      {children}
      {badge && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-rose-400 ring-2 ring-[var(--color-surface)]" />}
    </button>
  );
}
