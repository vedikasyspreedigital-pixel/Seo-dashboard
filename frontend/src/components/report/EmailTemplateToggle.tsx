import type { EmailVariant } from '../../api/types';

const OPTIONS: { value: EmailVariant; label: string; hint: string }[] = [
  { value: 'regular', label: 'Regular', hint: 'Ranking report only' },
  { value: 'ga', label: 'Google Analytics', hint: 'Also mentions the attached GA reports' },
];

/**
 * Regular / Google Analytics email template switch. Switching replaces the
 * email BODY with that template (the subject, recipients and CC stay as
 * edited); the GA template has [bracketed] placeholders for the GA numbers.
 */
export function EmailTemplateToggle({ value, onChange, disabled }: { value: EmailVariant; onChange: (v: EmailVariant) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="eyebrow-label">Email template</span>
      <div role="radiogroup" aria-label="Email template" className="inline-flex rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-1">
        {OPTIONS.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={o.label}
              title={o.hint}
              disabled={disabled || active}
              onClick={() => onChange(o.value)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 ${
                active ? 'accent-fill bg-gradient-to-br from-brand-400 to-brand-600 text-white' : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              } disabled:cursor-default ${!active && disabled ? 'opacity-50' : ''}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {value === 'ga' && (
        <span className="text-xs text-amber-300">Replace the [bracketed] GA numbers in the body before sending.</span>
      )}
    </div>
  );
}
