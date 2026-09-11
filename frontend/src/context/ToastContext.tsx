import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ToastTone } from '../components/run/runCompletionNotification';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_CLASSES: Record<ToastTone, string> = {
  success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  neutral: 'border-[var(--color-border-strong)] bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]',
};

const AUTO_DISMISS_MS = 6000;
// Must match the CSS transition-duration below -- actual removal from state
// is delayed by this long so the exit animation has time to play instead of
// the toast just vanishing mid-transition.
const EXIT_DURATION_MS = 180;

/**
 * One toast's enter/exit "pop" -- a spring-like slide+fade+scale, the same
 * shape shadcn's Toast/Sonner uses (Radix-based libraries drive this via
 * data-state attributes + CSS; this hand-rolls the equivalent since no
 * such library is in this app -- see ToastProvider's own comment on why).
 * `entered` starts false and flips true one frame after mount so the
 * "from" state actually paints before the transition to "to" starts --
 * applying the final classes in the very first render never animates,
 * since there's nothing to transition FROM yet.
 */
function ToastItem({ toast, leaving, onDismiss }: { toast: Toast; leaving: boolean; onDismiss: () => void }) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const settled = entered && !leaving;

  return (
    <div
      role="status"
      className={`glass-surface pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-medium shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition-all ease-out ${TONE_CLASSES[toast.tone]} ${
        settled ? 'translate-y-0 scale-100 opacity-100 duration-200' : 'translate-y-[-6px] scale-95 opacity-0 duration-150'
      }`}
    >
      <span>{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        aria-label="Dismiss notification"
      >
        &times;
      </button>
    </div>
  );
}

/**
 * App-wide in-app toast POPUP stack only -- mounted once in main.tsx
 * (outside the router) so it survives route navigation. Deliberately built
 * from scratch rather than pulling in a toast library: this fires a
 * handful of times per session, not a general notification system.
 *
 * The PERSISTENT notification list/badge/panel is a separate concern now,
 * backed by the real `Notification` DB table and polled via
 * useNotifications/NotificationBell -- this context used to also hold an
 * in-memory, non-persisted stand-in for that list before the backend table
 * existed. That's gone now to avoid two parallel, inconsistent notification
 * stores; this context is purely "show an ephemeral popup," triggered from
 * wherever a page already has fresh state to announce (e.g. RunDetailPage's
 * own live poll) in addition to (not instead of) the persistent one.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<number>>(new Set());
  const nextId = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    setLeavingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  // The actual dismiss trigger -- marks a toast "leaving" (plays its exit
  // transition via ToastItem) rather than removing it immediately, so both
  // the auto-dismiss timer and the manual X button get the same animated
  // exit instead of an instant pop-out.
  const dismiss = useCallback(
    (id: number) => {
      setLeavingIds((current) => new Set(current).add(id));
      window.setTimeout(() => remove(id), EXIT_DURATION_MS);
    },
    [remove],
  );

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'neutral') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, tone }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* top-24 (not top-6) so this clears the header's real rendered
          height (~80px, px-8 py-4 around ~48px-tall controls) -- AppShell's
          header isn't `fixed`, but it never scrolls away either (the column
          it's in is `overflow-hidden`, only `<main>` scrolls), so it
          occupies that space on every page. Newest toast rendered first
          (top of the stack, closest to where attention returns) by
          reversing render order only -- `toasts` itself stays append-order
          so dismiss-by-id and the auto-dismiss timers are unaffected. */}
      <div className="pointer-events-none fixed right-6 top-24 z-50 flex flex-col gap-2">
        {[...toasts].reverse().map((toast) => (
          <ToastItem key={toast.id} toast={toast} leaving={leavingIds.has(toast.id)} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
