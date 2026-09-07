import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useClients } from '../hooks/useClients';
import { useSession } from './SessionContext';
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
 * Reports, New Run) scopes its data to this client. Defaults to the first
 * client once the list loads; there's no persistence beyond the session.
 * Scoped to the active workspace (see SessionContext) -- switching
 * workspaces clears the selection so a client from the previous workspace
 * is never left selected. */
export function ClientProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useSession();
  const { clients, loading, refetch } = useClients(activeWorkspace?.id ?? null);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);

  useEffect(() => {
    setActiveClientId(null);
  }, [activeWorkspace?.id]);

  useEffect(() => {
    if (!activeClientId && clients.length > 0) setActiveClientId(clients[0].id);
  }, [clients, activeClientId]);

  const activeClient = clients.find((c) => c.id === activeClientId) ?? null;

  return <ClientContext.Provider value={{ clients, loading, activeClient, setActiveClientId, refetch }}>{children}</ClientContext.Provider>;
}

export function useActiveClient() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useActiveClient must be used within a ClientProvider');
  return ctx;
}
