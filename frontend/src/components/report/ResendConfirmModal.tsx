import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { formatReportDate } from '../../utils/formatters';

interface Props {
  open: boolean;
  /** How many times the report has already gone out, and when the last send was. */
  sendCount: number;
  lastSentAt: string | null;
  busy?: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

/**
 * The one warning shown before a report that was already sent to the client is
 * changed. Nothing is written until Continue -- the backend refuses the change
 * without this confirmation (RESEND_CONFIRMATION_REQUIRED).
 */
export function ResendConfirmModal({ open, sendCount, lastSentAt, busy = false, onCancel, onContinue }: Props) {
  const times = sendCount === 1 ? 'once' : `${sendCount} times`;
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title="This report was already sent"
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onContinue}>
            {busy && <Spinner />}
            Continue
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-[var(--color-ink-muted)]">
        <p>
          It was sent to the client {times}
          {lastSentAt ? (
            <>
              , last on <span className="font-semibold text-[var(--color-ink)]">{formatReportDate(lastSentAt)}</span>
            </>
          ) : null}
          .
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>The report, PDF and email are rebuilt and go back to <span className="text-[var(--color-ink)]">Pending approval</span>.</li>
          <li>
            When you send it, the client gets <span className="font-semibold text-[var(--color-ink)]">another email</span>, with “(Updated)” added to
            the subject.
          </li>
          <li>The corrected ranks then replace this report’s baseline for the next comparison.</li>
        </ul>
      </div>
    </Modal>
  );
}
