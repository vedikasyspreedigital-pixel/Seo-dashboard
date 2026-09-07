import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const baseInputClasses =
  'w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-60';

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${baseInputClasses} ${className}`.trim()} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${baseInputClasses} resize-y ${className}`.trim()} />;
}
