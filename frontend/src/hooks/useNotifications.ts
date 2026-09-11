import { useCallback, useEffect, useRef, useState } from 'react';
import { getNotifications, markNotificationsRead } from '../api/client';
import type { NotificationRecord } from '../api/types';

const POLL_INTERVAL_MS = 25000;

/**
 * Same plain setTimeout polling shape as useRunProgress -- one more
 * recurring request per open session is negligible at this app's scale,
 * and keeping the same pattern (no React Query/websockets) matches the
 * rest of the codebase's polling convention.
 */
export function useNotifications(workspaceId: string | null) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const data = await getNotifications(workspaceId as string);
        if (cancelled) return;
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      } catch {
        // Silently skip this tick -- a transient failure here shouldn't
        // surface as page-level error UI for a background poll; the next
        // tick just tries again.
      } finally {
        if (!cancelled) timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [workspaceId]);

  const markAllRead = useCallback(async () => {
    if (!workspaceId) return;
    setUnreadCount(0);
    setNotifications((current) => current.map((n) => ({ ...n, read: true })));
    await markNotificationsRead(workspaceId);
  }, [workspaceId]);

  return { notifications, unreadCount, markAllRead };
}
