import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, login as apiLogin, logout as apiLogout } from '../api/client';
import type { UserRecord, WorkspaceRecord } from '../api/types';

interface SessionContextValue {
  user: UserRecord | null;
  workspaces: WorkspaceRecord[];
  /** null only until the initial GET /auth/me resolves -- RequireAuth waits on this before deciding to redirect. */
  loading: boolean;
  activeWorkspace: WorkspaceRecord | null;
  setActiveWorkspaceId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Holds who's logged in and which of their workspaces is currently active --
 * sits above ClientProvider (see main.tsx) since the client list depends on
 * the active workspace. "Active workspace" is pure client-side state (same
 * pattern as ClientContext's own "active client"), defaulting to the first
 * workspace the user has a membership in; switching is instant, no reload.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setUser(session.user);
          setWorkspaces(session.workspaces);
          setActiveWorkspaceId(session.workspaces[0]?.id ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email: string, password: string) {
    const session = await apiLogin(email, password);
    setUser(session.user);
    setWorkspaces(session.workspaces);
    setActiveWorkspaceId(session.workspaces[0]?.id ?? null);
  }

  async function logout() {
    await apiLogout();
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspaceId(null);
  }

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  return (
    <SessionContext.Provider value={{ user, workspaces, loading, activeWorkspace, setActiveWorkspaceId, login, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
