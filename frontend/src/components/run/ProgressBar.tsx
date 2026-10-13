export function ProgressBar({ value }: { value: number }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
      <div
        className="accent-glow h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-500 shadow-[0_0_15px_rgba(0,169,195,0.3),0_0_35px_rgba(0,169,195,0.12)] transition-all duration-500 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
