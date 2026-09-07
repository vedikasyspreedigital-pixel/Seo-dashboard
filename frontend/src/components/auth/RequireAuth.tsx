import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '../../context/SessionContext';

/** Gates every existing route behind login. Waits for the initial GET /auth/me to resolve (SessionContext.loading) before deciding, so a logged-in user refreshing the page never flashes the login screen first. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
