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
        className="glass-surface w-full max-w-md rounded-[22px] border border-[var(--color-border)] p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_8px_30px_rgba(0,0,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
        <div className="mt-4">{children}</div>
        {footer && <div className="mt-6 flex items-center justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}
