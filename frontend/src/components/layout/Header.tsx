import { useActiveClient } from '../../context/ClientContext';
import { Select } from '../ui/Select';
import { BellIcon, SearchIcon, UserIcon } from '../ui/icons';

/** Global top bar, present on every page inside AppShell -- houses the
 * client switcher that used to live in the old text-label sidebar (every
 * page still scopes its data to one active client), plus search/notification/
 * profile chrome matching the reference dashboard's header. Search and
 * notifications are intentionally inert (no fabricated result count/badge --
 * this app has no search index or notification system to back them yet). */
export function Header() {
  const { clients, activeClient, setActiveClientId } = useActiveClient();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] px-8 py-4">
      <div className="w-64">
        <Select
          value={activeClient?.id ?? ''}
          onChange={setActiveClientId}
          placeholder="Select a client..."
          options={clients.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          title="Search (not yet available)"
          disabled
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-muted)] opacity-60"
        >
          <SearchIcon className="h-4.5 w-4.5" />
        </button>
        <button
          type="button"
          title="Notifications (not yet available)"
          disabled
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-muted)] opacity-60"
        >
          <BellIcon className="h-4.5 w-4.5" />
        </button>
        <div className="ml-1 flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] py-1.5 pl-1.5 pr-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
            <UserIcon className="h-3.5 w-3.5" />
          </span>
          <span className="leading-tight">
            <span className="block text-xs font-semibold text-[var(--color-ink)]">Admin</span>
            <span className="block text-[11px] text-[var(--color-ink-faint)]">Internal access</span>
          </span>
        </div>
      </div>
    </header>
  );
}
