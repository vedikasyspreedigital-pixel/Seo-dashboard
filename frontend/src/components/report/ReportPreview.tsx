import { Card } from '../ui/Card';
import { ReportStatusBadge } from './ReportStatusBadge';
import type { RankingReport } from '../../api/types';

export function ReportPreview({ report }: { report: RankingReport }) {
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Report preview</p>
        <ReportStatusBadge status={report.status} />
      </div>

      {report.reportHtml ? (
        <iframe
          title="Report preview"
          srcDoc={report.reportHtml}
          sandbox=""
          className="mt-4 h-[600px] w-full rounded-xl border border-[var(--color-border-strong)] bg-white"
        />
      ) : (
        <p className="mt-4 text-sm text-[var(--color-ink-muted)]">No report content yet.</p>
      )}
    </Card>
  );
}
