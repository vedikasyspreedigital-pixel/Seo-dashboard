import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { BackLink } from '../ui/BackLink';

/**
 * A report step whose report couldn't be loaded (deleted, a server restart, an expired login). These pages
 * used to stay on "Loading..." for good, because a failed request was never caught (audit 2026-10-27).
 */
export function ReportLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="mt-6 p-6">
      <p className="text-sm font-semibold text-rose-300">Couldn't load this report.</p>
      <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{message}</p>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
      <BackLink to="/reports" label="Back to Reports" />
    </Card>
  );
}
