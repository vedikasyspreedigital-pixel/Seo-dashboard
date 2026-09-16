import { useEffect, type ReactNode } from 'react';

/** Generic modal: backdrop + centered glass-surface panel, matching this app's existing Card look. Closes on Escape or a backdrop click -- never on a click inside the panel itself. */
export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="glass-surface flex max-h-[85vh] w-full max-w-md flex-col rounded-[22px] border border-[var(--color-border)] shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_8px_30px_rgba(0,0,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="shrink-0 px-6 pt-6 text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
        {/* min-h-0 is required for a flex child to actually become scrollable instead of stretching the whole panel past the viewport -- without it, a tall form (like Client Management's) pushes the footer's Save button off-screen entirely. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="shrink-0 flex items-center justify-end gap-3 px-6 pb-6">{footer}</div>}
      </div>
    </div>
  );
}
