import type { ReactNode } from 'react';
import { InlineError } from './InlineError';

/** Label + input/textarea + optional error, matching the label styling already used ad hoc across LoginPage/SendConfirmationPage/EmailDraftEditor (`mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]`). */
export function FormField({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">
        {label}
      </label>
      {children}
      <InlineError message={error} className="mt-1.5" />
    </div>
  );
}
