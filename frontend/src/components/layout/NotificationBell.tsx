import { useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { BellIcon } from '../ui/icons';
import { NotificationPanel } from './NotificationPanel';
import { useNotifications } from '../../hooks/useNotifications';
import { useSession } from '../../context/SessionContext';

/**
 * The header bell -- backed by the real, persisted Notification table (see
 * useNotifications), not client-side-only state. Clicking it opens the
 * left-sliding NotificationPanel and marks everything read; the badge
 * reflects the polled unread count.
 */
export function NotificationBell() {
  const { activeWorkspace } = useSession();
  const { notifications, unreadCount, markAllRead } = useNotifications(activeWorkspace?.id ?? null);
  const [open, setOpen] = useState(false);

  function handleOpen() {
    setOpen(true);
    void markAllRead();
  }

  return (
    <>
      <IconButton title="Notifications" onClick={handleOpen} badge={unreadCount > 0}>
        <BellIcon className="h-4.5 w-4.5" />
      </IconButton>
      <NotificationPanel open={open} onClose={() => setOpen(false)} notifications={notifications} />
    </>
  );
}
