import { useActiveClient } from '../../context/ClientContext';
import { useSession } from '../../context/SessionContext';
import { Select } from '../ui/Select';
import { IconButton } from '../ui/IconButton';
import { NotificationBell } from './NotificationBell';
import { SearchIcon, UserIcon } from '../ui/icons';

/** Global top bar, present on every page inside AppShell -- houses the
 * client switcher that used to live in the old text-label sidebar (every
 * page still scopes its data to one active client), plus search/notification/
 * profile chrome matching the reference dashboard's header. Search is still
 * intentionally inert (no search index to back it yet); notifications are
 * now real, backed by ToastContext (see NotificationBell).
 * The user/workspace pill on the right is now real session state (was a
 * static "Admin / Internal access" placeholder) -- the workspace switcher
 * only renders when the signed-in user actually has more than one
 * workspace; a single-workspace user just sees their workspace name. */
export function Header() {
  const { clients, activeClient, setActiveClientId } = useActiveClient();
  const { user, workspaces, activeWorkspace, setActiveWorkspaceId, logout } = useSession();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] px-8 py-4">
      <div className="flex items-center gap-3">
        {workspaces.length > 1 && (
          <div className="w-40">
            <Select
              value={activeWorkspace?.id ?? ''}
              onChange={setActiveWorkspaceId}
              placeholder="Workspace..."
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
        )}
        <div className="w-64">
          <Select
            value={activeClient?.id ?? ''}
            onChange={setActiveClientId}
            placeholder="Select a client..."
            options={clients.map((c) => ({ value: c.id, label: c.name }))}
            searchable
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <IconButton title="Search (not yet available)" disabled>
          <SearchIcon className="h-4.5 w-4.5" />
        </IconButton>
        <NotificationBell />
        <div className="ml-1 flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] py-1.5 pl-1.5 pr-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
            <UserIcon className="h-3.5 w-3.5" />
          </span>
          <span className="leading-tight">
            <span className="block text-xs font-semibold text-[var(--color-ink)]">{user?.name ?? user?.email ?? '...'}</span>
            <span className="block text-[11px] text-[var(--color-ink-faint)]">{activeWorkspace?.name ?? 'No workspace'}</span>
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            className="ml-1 text-[11px] font-semibold text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
          >
            Log out
          </button>
        </div>
      </div>
    </header>
  );
}
