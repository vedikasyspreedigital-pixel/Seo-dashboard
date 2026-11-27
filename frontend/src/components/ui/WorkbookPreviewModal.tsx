import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import type { WorkbookPreview } from '../../api/client';

/**
 * "Preview" for an Excel file (2026-11-27): its sheets as tables, to check a Domain Intelligence file or an
 * edited Baseline Report on screen before it goes out. `load` fetches it when the window opens.
 */
export function WorkbookPreviewModal({ title, load, onClose }: { title: string | null; load: () => Promise<WorkbookPreview>; onClose: () => void }) {
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(0);

  useEffect(() => {
    if (!title) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setSheet(0);
    load()
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // `load` changes every render; the title identifies the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const current = preview?.sheets[sheet];
  const width = current ? Math.max(0, ...current.rows.map((r) => r.length)) : 0;

  return (
    <Modal open={!!title} onClose={onClose} title={title ?? ''} wide>
      {error ? (
        <p className="text-sm text-rose-300">Couldn't open it: {error}</p>
      ) : !preview ? (
        <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Opening…
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          {preview.sheets.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Sheets">
              {preview.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  aria-selected={i === sheet}
                  onClick={() => setSheet(i)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    i === sheet ? 'accent-fill bg-brand-500 text-white' : 'border border-[var(--color-border-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {current && current.rows.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-faint)]">This sheet is empty.</p>
          ) : (
            current && (
              <div className="max-h-[60vh] overflow-auto rounded-xl border border-[var(--color-border)]">
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    {current.rows.map((row, r) => (
                      <tr key={r} className={r === 0 ? 'sticky top-0 bg-[var(--color-surface)] font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}>
                        {Array.from({ length: width }, (_, c) => (
                          <td key={c} className="whitespace-nowrap border-b border-r border-[var(--color-border)] px-2.5 py-1.5 align-top">
                            {row[c] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {current?.truncated && <p className="text-xs text-[var(--color-ink-faint)]">Showing the first part only ({current.totalRows} rows in this sheet) — download it to see everything.</p>}
        </div>
      )}
    </Modal>
  );
}
