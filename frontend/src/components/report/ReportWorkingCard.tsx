import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

export function ReportWorkingCard({ label }: { label: string }) {
  return (
    <Card className="flex items-center gap-3 p-6">
      <Spinner className="h-5 w-5 text-brand-300" />
      <p className="text-sm font-medium text-[var(--color-ink-muted)]">{label}</p>
    </Card>
  );
}
