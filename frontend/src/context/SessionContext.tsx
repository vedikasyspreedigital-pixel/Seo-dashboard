import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, login as apiLogin, logout as apiLogout } from '../api/client';
import { readStoredWorkspaceId, writeStoredWorkspaceId, clearStoredWorkspaceId, resolveActiveWorkspaceId } from '../utils/workspaceSelection';
import type { UserRecord, WorkspaceRecord } from '../api/types';

interface SessionContextValue {
  user: UserRecord | null;
  workspaces: WorkspaceRecord[];
  /** null only until the initial GET /auth/me resolves -- RequireAuth waits on this before deciding to redirect. */
  loading: boolean;
  /** True while the server can't be reached to check the session (e.g. a deploy restart) -- NOT the same as logged out. */
  unreachable: boolean;
  activeWorkspace: WorkspaceRecord | null;
  setActiveWorkspaceId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Holds who's logged in and which of their workspaces is currently active --
 * sits above ClientProvider (see main.tsx) since the client list depends on
 * the active workspace. Persisted per-user (see utils/workspaceSelection.ts)
 * and restored on refresh/login ONLY if the stored id is still one of this
 * user's actual memberships -- a workspace they no longer belong to is never
 * silently restored, it's treated exactly like "nothing stored" and falls
 * back to the first workspace instead (unlike client selection, every page
 * here assumes SOME workspace is active, so there's no "none selected" empty
 * state to fall back to). Switching is instant, no reload.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // Only a real 401 (getMe -> null) means "logged out". A server that can't
    // be reached (deploy restart, network blip) used to land here too and
    // sent everyone to the Sign-in page, as if their data were gone
    // (2026-10-16). Now it keeps checking every few seconds until it answers.
    const check = () => {
      getMe()
        .then((session) => {
          if (cancelled) return;
          setUnreachable(false);
          if (session) {
            setUser(session.user);
            setWorkspaces(session.workspaces);
            const stored = readStoredWorkspaceId(session.user.id);
            const resolved = resolveActiveWorkspaceId(stored, session.workspaces);
            if (stored && stored !== resolved) clearStoredWorkspaceId(session.user.id); // no longer a member -- don't keep it around
            setActiveWorkspaceIdState(resolved);
          }
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setUnreachable(true);
          setLoading(false);
          timer = window.setTimeout(check, 5000);
        });
    };
    check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  async function login(email: string, password: string) {
    const session = await apiLogin(email, password);
    setUser(session.user);
    setWorkspaces(session.workspaces);
    const stored = readStoredWorkspaceId(session.user.id);
    const resolved = resolveActiveWorkspaceId(stored, session.workspaces);
    if (stored && stored !== resolved) clearStoredWorkspaceId(session.user.id);
    setActiveWorkspaceIdState(resolved);
  }

  async function logout() {
    await apiLogout();
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspaceIdState(null);
  }

  function setActiveWorkspaceId(id: string) {
    setActiveWorkspaceIdState(id);
    if (user) writeStoredWorkspaceId(user.id, id);
  }

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  return (
    <SessionContext.Provider value={{ user, workspaces, loading, unreachable, activeWorkspace, setActiveWorkspaceId, login, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
