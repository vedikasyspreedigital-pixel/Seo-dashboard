import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { getExtraAttachmentPreview, type ExcelPreview } from '../../api/client';

export interface ViewedAttachment {
  filename: string;
  /** The stored file (a PDF shows inline; anything else downloads). */
  url: string;
  /** Set for an extra attachment, so an Excel file can be previewed as a table. */
  reportId?: string;
  attachmentId?: string;
}

/**
 * The eye button's viewer: shows an attached file on the same page. A PDF in
 * the browser's own PDF viewer; an Excel file as a table of its cells (first
 * 500 rows / 30 columns of each sheet). Download is always there too.
 * Rendered into <body>: inside the Attachments card, the card's styling would
 * pin the "fixed" overlay to the card instead of the screen.
 */
export function AttachmentViewerModal({ attachment, onClose }: { attachment: ViewedAttachment | null; onClose: () => void }) {
  const isPdf = !!attachment && /\.pdf$/i.test(attachment.filename);
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(0);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setSheet(0);
    if (!attachment || isPdf) return;
    if (!attachment.reportId || !attachment.attachmentId) {
      setError("This file can't be previewed here -- download it to view.");
      return;
    }
    let cancelled = false;
    getExtraAttachmentPreview(attachment.reportId, attachment.attachmentId)
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [attachment, isPdf]);

  const current = preview?.sheets[sheet];

  return createPortal(
    <Modal
      open={attachment !== null}
      onClose={onClose}
      title={attachment?.filename ?? ''}
      wide
      footer={
        <>
          {attachment && (
            <a href={attachment.url} download={attachment.filename}>
              <Button variant="secondary">Download</Button>
            </a>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {attachment && isPdf && <iframe title={attachment.filename} src={attachment.url} className="h-full min-h-[60vh] w-full rounded-xl border-0 bg-white" />}

      {attachment && !isPdf && (
        <>
          {error && <p className="text-sm text-amber-300">{error}</p>}
          {!error && !preview && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Spinner /> Loading the sheet...
            </div>
          )}
          {preview && preview.sheets.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {preview.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setSheet(i)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${i === sheet ? 'bg-brand-500/20 text-brand-200' : 'text-[var(--color-ink-muted)] hover:bg-overlay/[0.06]'}`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {current &&
            (current.rows.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-muted)]">This sheet is empty.</p>
            ) : (
              <div className="overflow-auto rounded-xl border border-[var(--color-border)]">
                <table className="min-w-full border-collapse text-xs">
                  <tbody>
                    {current.rows.map((row, r) => (
                      <tr key={r} className={r === 0 ? 'bg-[var(--color-surface-2)] font-semibold' : ''}>
                        {row.map((cell, c) => (
                          <td key={c} className="whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-ink)]">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {current?.truncated && <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Showing the first 500 rows and 30 columns -- download the file to see all of it.</p>}
        </>
      )}
    </Modal>,
    document.body,
  );
}
