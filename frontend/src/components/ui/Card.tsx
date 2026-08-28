import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  highlight?: boolean;
}

export function Card({ children, className = '', highlight = false }: Props) {
  if (highlight) {
    return (
      <div
        className={`bg-gradient-to-br from-brand-400 to-brand-600 rounded-[22px] shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset,0_0_20px_rgba(139,92,246,0.15),0_0_40px_rgba(139,92,246,0.08),0_12px_40px_rgba(0,0,0,0.35)] ${className}`}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={`glass-surface rounded-[22px] border border-[var(--color-border)] shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_8px_30px_rgba(0,0,0,0.25)] ${className}`}
    >
      {children}
    </div>
  );
}
