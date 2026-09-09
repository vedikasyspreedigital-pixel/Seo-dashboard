import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useClients } from '../hooks/useClients';
import { useSession } from './SessionContext';
import { readStoredClientId, writeStoredClientId, clearStoredClientId, resolveActiveClientId } from '../utils/clientSelection';
import type { ClientRecord } from '../api/types';

interface ClientContextValue {
  clients: ClientRecord[];
  loading: boolean;
  activeClient: ClientRecord | null;
  setActiveClientId: (id: string) => void;
  /** Re-fetches the dropdown-backing client list -- call after a Client Management mutation (create/deactivate/archive/etc.) so the Header dropdown reflects it without a page reload. */
  refetch: () => void;
}

const ClientContext = createContext<ClientContextValue | null>(null);

/** Holds the header's "active client" selection -- every page (Runs,
 * Reports, New Run) scopes its data to this client. Persisted per-workspace
 * (see utils/clientSelection.ts) and restored on refresh ONLY if the stored
 * id still names a real, active client in the current workspace's client
 * list -- deleted, deactivated, archived, or foreign-workspace ids are
 * cleared instead. Never silently substitutes clients[0] or any other
 * client: an empty/invalid selection stays empty (activeClient: null) until
 * the user explicitly picks one. Switching workspaces immediately clears
 * the in-memory selection (never shows a previous workspace's client while
 * the new one's list is loading), then independently restores THAT
 * workspace's own persisted selection once its client list has loaded --
 * so a client chosen in one workspace can never leak into another. */
export function ClientProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useSession();
  const { clients, loading, forWorkspaceId, refetch } = useClients(activeWorkspace?.id ?? null);
  const [activeClientId, setActiveClientIdState] = useState<string | null>(null);

  useEffect(() => {
    setActiveClientIdState(null);
  }, [activeWorkspace?.id]);

  useEffect(() => {
    // Gated on forWorkspaceId (set atomically alongside `clients` itself),
    // NOT `loading` -- `loading` flips to true asynchronously inside
    // useClients' own effect, so right after a workspace switch this effect
    // can otherwise still see last render's stale `loading: false` /
    // `clients: []` pair before that effect has run, and wrongly conclude
    // the stored selection is invalid (clearing a perfectly good one).
    // forWorkspaceId only ever matches once the list actually in `clients`
    // is confirmed to belong to this exact workspace.
    if (!activeWorkspace || forWorkspaceId !== activeWorkspace.id) return;
    const stored = readStoredClientId(activeWorkspace.id);
    const resolved = resolveActiveClientId(stored, clients);
    if (stored && !resolved) clearStoredClientId(activeWorkspace.id); // stale/foreign/deleted/inactive -- don't keep it around
    setActiveClientIdState(resolved);
  }, [activeWorkspace?.id, clients, forWorkspaceId]);

  function setActiveClientId(id: string) {
    setActiveClientIdState(id);
    if (activeWorkspace) writeStoredClientId(activeWorkspace.id, id);
  }

  const activeClient = clients.find((c) => c.id === activeClientId) ?? null;

  return <ClientContext.Provider value={{ clients, loading, activeClient, setActiveClientId, refetch }}>{children}</ClientContext.Provider>;
}

export function useActiveClient() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useActiveClient must be used within a ClientProvider');
  return ctx;
}
