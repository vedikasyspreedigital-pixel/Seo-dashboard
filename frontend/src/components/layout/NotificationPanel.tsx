import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationRecord, NotificationType } from '../../api/types';

const DOT_CLASSES: Record<NotificationType, string> = {
  RUN_COMPLETED: 'bg-emerald-400',
  RUN_COMPLETED_WITH_ERRORS: 'bg-amber-400',
  REPORT_SENT: 'bg-brand-300',
  REPORT_SEND_FAILED: 'bg-rose-400',
};

function formatRelativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

interface Props {
  open: boolean;
  onClose: () => void;
  notifications: NotificationRecord[];
}

/**
 * Slides in from the LEFT (not the app's existing centered Modal pattern) --
 * always mounted, visibility/position driven by translate-x + opacity
 * classes rather than conditional unmount, so the slide actually animates
 * on open/close instead of popping in instantly. Escape/backdrop-click to
 * close, same convention as Modal.tsx.
 */
export function NotificationPanel({ open, onClose, notifications }: Props) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 z-50 bg-black/60 transition-opacity duration-300 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className={`glass-surface fixed inset-y-0 left-0 z-50 flex w-96 max-w-[90vw] flex-col border-r border-[var(--color-border)] shadow-[0_0_40px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Notifications</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notifications"
            className="rounded-full p-1.5 text-[var(--color-ink-faint)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[var(--color-ink-faint)]">No notifications yet</p>
          ) : (
            <ul>
              {notifications.map((n) => {
                const clickable = Boolean(n.runId);
                return (
                  <li
                    key={n.id}
                    onClick={
                      clickable
                        ? () => {
                            onClose();
                            navigate(`/runs/${n.runId}`);
                          }
                        : undefined
                    }
                    className={`flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-3.5 ${
                      clickable ? 'cursor-pointer hover:bg-white/[0.03]' : ''
                    } ${n.read ? '' : 'bg-white/[0.02]'}`}
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLASSES[n.type]}`} />
                    <span>
                      <span className="block text-sm text-[var(--color-ink)]">{n.message}</span>
                      <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">{formatRelativeTime(n.createdAt)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
