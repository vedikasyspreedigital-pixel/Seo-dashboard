import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3),0_0_35px_rgba(139,92,246,0.12)] hover:brightness-110 hover:shadow-[0_0_20px_rgba(139,92,246,0.4),0_0_45px_rgba(139,92,246,0.18)]',
  secondary:
    'bg-white/[0.04] text-[var(--color-ink)] border border-white/[0.07] hover:bg-white/[0.07] hover:border-white/[0.1]',
  ghost: 'bg-transparent text-[var(--color-ink-muted)] hover:bg-white/[0.04] hover:text-[var(--color-ink)]',
  danger:
    'bg-rose-500/10 text-rose-300 border border-rose-500/25 hover:bg-rose-500/15 hover:border-rose-500/40',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold tracking-tight transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
