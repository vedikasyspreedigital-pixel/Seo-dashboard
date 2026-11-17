import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import type { BaselineClientPreview as Preview } from '../../api/types';

/**
 * "Preview client copy" (2026-11-17): the Baseline Report exactly as the client gets it -- grey title, the letter,
 * the orange header row and the keywords, without the team-only Number of Result / SERP result columns.
 */
export function BaselineClientPreview({
  open,
  onClose,
  preview,
  loading = false,
  error = null,
}: {
  open: boolean;
  onClose: () => void;
  preview: Preview | null;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Client copy preview"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Building the preview…
        </div>
      )}
      {error && <p className="text-sm text-rose-300">{error}</p>}
      {preview && !loading && (
        <div className="overflow-x-auto rounded-lg bg-white text-[13px] text-black">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th colSpan={preview.headers.length} className="border border-black bg-[#808080] px-3 py-2 text-right align-top font-bold whitespace-pre-line text-white">
                  {`Client Keyword Baseline Report\n${preview.domain}\n${preview.dateLabel}`}
                </th>
              </tr>
              <tr>
                <td colSpan={preview.headers.length} className="border border-black px-3 py-2 align-top whitespace-pre-line">
                  {preview.letter}
                </td>
              </tr>
              <tr>
                {preview.headers.map((h, i) => (
                  <th key={h} className={`border border-black bg-[#FF6600] px-2 py-1.5 font-bold text-white ${i === 0 ? 'text-left' : 'text-center'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((v, c) => (
                    <td key={c} className={`border border-black px-2 py-1 ${c === 0 ? 'text-left' : 'text-center'}`}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview && !loading && (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          {preview.rows.length} keywords. Number of Result and SERP result aren’t in the client copy — they stay in the team download.
        </p>
      )}
    </Modal>
  );
}
