import { AppShell } from '../components/layout/AppShell';
import { PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { THEMES, useTheme } from '../hooks/useTheme';

/**
 * "Settings": dashboard theme for this browser -- each option shows its colour
 * strip. Nothing is sent to the server; the client report PDF and emails keep
 * their own colours.
 */
export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <AppShell>
      <PageTitle
        title="Settings"
        subtitle="Choose how the dashboard looks in this browser. Client reports and emails are not affected."
        className="mt-0"
      />

      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Colour theme</h2>
        <div className="mt-4 flex flex-col gap-3" role="radiogroup" aria-label="Colour theme">
          {THEMES.map((t) => {
            const selected = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(t.value)}
                className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-4 py-3.5 text-left transition-colors ${
                  selected
                    ? 'border-brand-400 bg-brand-500/10'
                    : 'border-[var(--color-border-strong)] hover:bg-overlay/[0.04]'
                }`}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      selected ? 'border-brand-400' : 'border-[var(--color-ink-faint)]'
                    }`}
                  >
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-[var(--color-ink)]">{t.name}</span>
                    <span className="block text-xs text-[var(--color-ink-muted)]">{t.description}</span>
                  </span>
                </span>
                <span className="flex overflow-hidden rounded-lg border border-[var(--color-border-strong)]">
                  {t.swatches.map((c) => (
                    <span key={c} className="h-7 w-10" style={{ backgroundColor: c }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </Card>
    </AppShell>
  );
}
