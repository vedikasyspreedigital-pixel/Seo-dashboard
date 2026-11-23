import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../../context/SessionContext';
import { getClients } from '../../api/client';
import type { ClientRecord } from '../../api/types';

export const OPEN_COMMAND_PALETTE = 'open-command-palette';

const PAGES = [
  { label: 'Overview', to: '/overview' },
  { label: 'Portfolio', to: '/portfolio' },
  { label: 'Runs', to: '/runs' },
  { label: 'New run', to: '/runs/new' },
  { label: 'Run slots', to: '/run-slots' },
  { label: 'Reports', to: '/reports' },
  { label: 'Compare reports', to: '/compare' },
  { label: 'Domain Intelligence', to: '/domain-intelligence' },
  { label: 'Client Management', to: '/clients' },
  { label: 'Settings', to: '/settings' },
];

type Item = { kind: 'page' | 'client'; label: string; hint?: string; to: string };

/**
 * Ctrl+K / Cmd+K (UI polish, 2026-11-23): jump to any client's page or any screen by typing a few letters.
 * Also opened by the search button in the header.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { activeWorkspace } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    if (activeWorkspace) getClients(activeWorkspace.id).then(setClients).catch(() => setClients([]));
  }, [open, activeWorkspace]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const clientItems = clients
      .filter((c) => match(c.name) || match(c.domain ?? ''))
      .slice(0, 8)
      .map((c) => ({ kind: 'client' as const, label: c.name, hint: c.domain ?? undefined, to: `/clients/${c.id}` }));
    const pageItems = PAGES.filter((p) => match(p.label)).map((p) => ({ kind: 'page' as const, label: p.label, to: p.to }));
    return q ? [...clientItems, ...pageItems] : [...pageItems, ...clientItems];
  }, [query, clients]);

  if (!open) return null;

  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    navigate(item.to);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[14vh]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label="Quick search"
        className="glass-surface w-full max-w-lg overflow-hidden rounded-[18px] border border-[var(--color-border-strong)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') go(items[active]);
          }}
          placeholder="Search clients or pages…"
          className="w-full border-b border-[var(--color-border)] bg-transparent px-5 py-4 text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        <ul className="max-h-80 overflow-y-auto py-2" role="listbox">
          {items.length === 0 && <li className="px-5 py-3 text-sm text-[var(--color-ink-faint)]">Nothing found.</li>}
          {items.map((item, i) => (
            <li key={`${item.kind}-${item.to}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item)}
                className={`flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-sm ${i === active ? 'bg-overlay/[0.06] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
              >
                <span className="truncate">
                  {item.label}
                  {item.hint && <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{item.hint}</span>}
                </span>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">{item.kind === 'client' ? 'Client' : 'Page'}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-[var(--color-border)] px-5 py-2 text-[11px] text-[var(--color-ink-faint)]">↑ ↓ to move · Enter to open · Esc to close</p>
      </div>
    </div>
  );
}
