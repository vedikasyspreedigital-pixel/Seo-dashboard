import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useClients } from '../hooks/useClients';
import type { ClientRecord } from '../api/types';

interface ClientContextValue {
  clients: ClientRecord[];
  loading: boolean;
  activeClient: ClientRecord | null;
  setActiveClientId: (id: string) => void;
}

const ClientContext = createContext<ClientContextValue | null>(null);

/** Holds the sidebar's "active client" selection -- every page (Runs,
 * Reports, New Run) scopes its data to this client. Defaults to the first
 * client once the list loads; there's no persistence beyond the session. */
export function ClientProvider({ children }: { children: ReactNode }) {
  const { clients, loading } = useClients();
  const [activeClientId, setActiveClientId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeClientId && clients.length > 0) setActiveClientId(clients[0].id);
  }, [clients, activeClientId]);

  const activeClient = clients.find((c) => c.id === activeClientId) ?? null;

  return <ClientContext.Provider value={{ clients, loading, activeClient, setActiveClientId }}>{children}</ClientContext.Provider>;
}

export function useActiveClient() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useActiveClient must be used within a ClientProvider');
  return ctx;
}
