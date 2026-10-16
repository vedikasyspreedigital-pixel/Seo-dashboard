import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '../../context/SessionContext';
import { Spinner } from '../ui/Spinner';

/**
 * Gates every existing route behind login. Waits for the initial GET /auth/me
 * to resolve (SessionContext.loading) before deciding, so a logged-in user
 * refreshing the page never flashes the login screen first. If the server
 * can't be reached at all (e.g. while it restarts after a deploy), shows a
 * "reconnecting" screen instead of sending the user to Sign in.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, unreachable } = useSession();
  const location = useLocation();

  if (loading) return null;
  if (!user && unreachable) {
    return (
      <div className="app-backdrop flex h-screen items-center justify-center px-6">
        <div className="glass-surface flex max-w-sm flex-col items-center gap-3 rounded-[22px] p-8 text-center">
          <Spinner />
          <p className="text-base font-semibold text-[var(--color-ink)]">Reconnecting to the server…</p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            The dashboard is briefly unavailable (usually while an update is deployed). Your data is safe -- this page will continue on its own.
          </p>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
