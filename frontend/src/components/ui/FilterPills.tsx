/** Generic exclusive-choice pill row -- the same gradient-active-pill treatment RunDetailPage already hand-rolled for its row-status filter, now shared with any other exclusive filter (e.g. Client Management's Active/Inactive/Archived). Renders only the pills themselves; a label/border wrapper, if wanted, stays in the caller. */
export function FilterPills<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
            value === option
              ? 'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3),0_0_35px_rgba(139,92,246,0.12)]'
              : 'text-[var(--color-ink-muted)] hover:bg-white/[0.04]'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
