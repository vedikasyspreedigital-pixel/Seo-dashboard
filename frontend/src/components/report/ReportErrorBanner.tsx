import { Card } from '../ui/Card';

export function ReportErrorBanner({ message }: { message: string }) {
  return (
    <Card className="border-rose-500/25 bg-rose-500/[0.05] p-4">
      <p className="text-sm font-medium text-rose-300">{message}</p>
    </Card>
  );
}
