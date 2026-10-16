import { useCallback, useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { LayoutIcon, RefreshIcon, UploadDropIcon, UserIcon } from '../components/ui/icons';
import { THEMES, useTheme } from '../hooks/useTheme';
import { useSession } from '../context/SessionContext';
import { getStorageUsage, type StorageUsage } from '../api/client';

type Section = 'appearance' | 'storage' | 'account';
const SECTIONS: { id: Section; label: string; hint: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme for this browser', icon: LayoutIcon },
  { id: 'storage', label: 'Storage', hint: 'Disk space used by files', icon: UploadDropIcon },
  { id: 'account', label: 'Account', hint: 'Who is signed in', icon: UserIcon },
];

const STORAGE_LABELS: Record<keyof StorageUsage['usedByApp'], { label: string; hint: string; color: string }> = {
  reportPdfs: { label: 'Report PDFs', hint: 'Generated client reports', color: 'var(--color-brand-400)' },
  extraPdfs: { label: 'Extra email PDFs', hint: 'e.g. Google Analytics reports', color: '#60a5fa' },
  uploadedExcels: { label: 'Uploaded Excels', hint: 'Run & verified ranking files', color: '#34d399' },
  domainReports: { label: 'Domain Intelligence', hint: 'Keyword export reports', color: '#a78bfa' },
  debugSnapshots: { label: 'ClickUp debug snapshots', hint: 'Only the newest few are kept', color: '#fbbf24' },
  other: { label: 'Other', hint: 'Saved ClickUp logins and misc.', color: 'var(--color-ink-faint)' },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Settings: Appearance (theme), Storage (how full the uploads disk is and what
 * fills it -- it ran out once, 15 Oct 2026), Account. Theme is per browser;
 * client reports and emails are never affected.
 */
export function SettingsPage() {
  const [section, setSection] = useState<Section>(() => {
    const fromHash = window.location.hash.replace('#', '') as Section;
    return SECTIONS.some((s) => s.id === fromHash) ? fromHash : 'appearance';
  });

  function open(id: Section) {
    setSection(id);
    window.history.replaceState(null, '', `#${id}`);
  }

  return (
    <AppShell>
      <PageTitle title="Settings" subtitle="Personalise the dashboard and keep an eye on storage." className="mt-0" />

      <div className="mt-6 grid gap-6 md:grid-cols-[220px_1fr]">
        <nav className="flex gap-2 md:flex-col" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => open(s.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-1 items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors md:flex-none ${
                  active ? 'bg-overlay/[0.07] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)] hover:bg-overlay/[0.04] hover:text-[var(--color-ink)]'
                }`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${active ? 'accent-fill bg-gradient-to-br from-brand-400 to-brand-600 text-white' : 'bg-overlay/[0.05]'}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="hidden sm:block">
                  <span className="block text-sm font-semibold">{s.label}</span>
                  <span className="block text-xs text-[var(--color-ink-faint)]">{s.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div key={section} className="page-enter">
          {section === 'appearance' && <AppearanceSection />}
          {section === 'storage' && <StorageSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </AppShell>
  );
}

function SectionCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-[var(--color-ink)]">{title}</h2>
      <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{description}</p>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <SectionCard title="Theme" description="Applies to this browser only. Client report PDFs and emails keep their own look.">
      <div className="grid gap-4 sm:grid-cols-3" role="radiogroup" aria-label="Colour theme">
        {THEMES.map((t) => {
          const selected = theme === t.value;
          const [page, card, ink, accent] = t.swatches;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(t.value)}
              className={`group overflow-hidden rounded-2xl border text-left transition-all duration-200 ${
                selected ? 'border-brand-400 ring-2 ring-brand-400/30' : 'border-[var(--color-border-strong)] hover:-translate-y-0.5 hover:border-[var(--color-ink-faint)]'
              }`}
            >
              {/* Mini preview of the theme: sidebar dot, a card, a button, an accent line. */}
              <div className="flex h-24 gap-2 p-3" style={{ backgroundColor: page }}>
                <div className="flex w-5 flex-col items-center gap-1.5 pt-1">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: ink }} />
                  <span className="h-3 w-3 rounded-full opacity-40" style={{ backgroundColor: ink }} />
                  <span className="h-3 w-3 rounded-full opacity-40" style={{ backgroundColor: ink }} />
                </div>
                <div className="flex flex-1 flex-col gap-1.5 rounded-lg p-2" style={{ backgroundColor: card }}>
                  <span className="h-1.5 w-2/3 rounded-full opacity-70" style={{ backgroundColor: ink }} />
                  <span className="h-1.5 w-1/3 rounded-full" style={{ backgroundColor: accent }} />
                  <span className="mt-auto h-3.5 w-12 rounded-full" style={{ backgroundColor: ink }} />
                </div>
              </div>
              <div className="flex items-start justify-between gap-2 px-4 py-3">
                <span>
                  <span className="block text-sm font-semibold text-[var(--color-ink)]">{t.name}</span>
                  <span className="block text-xs text-[var(--color-ink-muted)]">{t.description}</span>
                </span>
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-brand-400' : 'border-[var(--color-ink-faint)]'}`}>
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </SectionCard>
  );
}

function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getStorageUsage()
      .then(setUsage)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const disk = usage?.disk ?? null;
  const usedPct = disk ? Math.min(100, Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)) : null;
  const tone = usedPct === null ? 'bg-brand-400' : usedPct >= 90 ? 'bg-rose-500' : usedPct >= 70 ? 'bg-amber-400' : 'bg-emerald-500';
  const rows = usage ? (Object.keys(STORAGE_LABELS) as (keyof StorageUsage['usedByApp'])[]).map((k) => ({ key: k, bytes: usage.usedByApp[k], ...STORAGE_LABELS[k] })) : [];
  const maxRow = Math.max(1, ...rows.map((r) => r.bytes));

  return (
    <SectionCard title="Storage" description="Uploaded Excels, report PDFs and email attachments share one disk. When it is full, uploads and new report PDFs fail.">
      <div className="flex justify-end">
        <Button variant="ghost" disabled={loading} onClick={load}>
          {loading ? <Spinner /> : <RefreshIcon className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-rose-300">Couldn't read storage: {error}</p>}

      {usage && (
        <>
          {disk && usedPct !== null ? (
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold text-[var(--color-ink)]">{usedPct}% used</span>
                <span className="text-sm text-[var(--color-ink-muted)]">
                  {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                </span>
              </div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-overlay/[0.07]">
                <div className={`h-full rounded-full ${tone} transition-all duration-700`} style={{ width: `${usedPct}%` }} />
              </div>
              {usedPct >= 80 && (
                <p className="mt-3 text-sm text-amber-300">The disk is getting full. Delete old runs on the Runs page (their files are removed with them) to free space.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-ink-muted)]">Disk size isn't available here; the breakdown below shows what the dashboard stores.</p>
          )}

          <div className="mt-6 flex flex-col gap-3">
            <p className="eyebrow-label">Used by the dashboard &middot; {formatBytes(usage.appTotalBytes)}</p>
            {rows.map((r) => (
              <div key={r.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[200px_1fr_70px]">
                <span>
                  <span className="block text-sm text-[var(--color-ink)]">{r.label}</span>
                  <span className="block text-xs text-[var(--color-ink-faint)]">{r.hint}</span>
                </span>
                <span className="order-3 col-span-2 h-2 overflow-hidden rounded-full bg-overlay/[0.06] sm:order-none sm:col-span-1">
                  <span className="block h-full rounded-full transition-all duration-700" style={{ width: `${(r.bytes / maxRow) * 100}%`, backgroundColor: r.color }} />
                </span>
                <span className="text-right text-sm font-medium tabular-nums text-[var(--color-ink-muted)]">{formatBytes(r.bytes)}</span>
              </div>
            ))}
          </div>

          <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
            To free space, delete old runs on the Runs page -- each run's Excel, report PDF and email attachments are removed with it. Sent reports' history stays in the database.
          </p>
        </>
      )}
    </SectionCard>
  );
}

function AccountSection() {
  const { user, activeWorkspace, workspaces, logout } = useSession();
  return (
    <SectionCard title="Account" description="The account signed in to this dashboard in this browser.">
      <div className="flex flex-wrap items-center gap-4">
        <span className="accent-fill flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
          <UserIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{user?.name ?? user?.email ?? '...'}</p>
          {user?.name && <p className="truncate text-xs text-[var(--color-ink-muted)]">{user.email}</p>}
        </div>
        <Button variant="secondary" onClick={() => void logout()}>
          Log out
        </Button>
      </div>
      <div className="mt-5 rounded-2xl bg-overlay/[0.04] px-4 py-3 text-sm">
        <span className="text-[var(--color-ink-faint)]">Workspace{workspaces.length > 1 ? 's' : ''}: </span>
        <span className="text-[var(--color-ink)]">{workspaces.map((w) => (w.id === activeWorkspace?.id ? `${w.name} (active)` : w.name)).join(', ') || '—'}</span>
      </div>
    </SectionCard>
  );
}
