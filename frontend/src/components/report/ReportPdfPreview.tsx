import { Card } from '../ui/Card';
import { getReportPdfUrl } from '../../api/client';

/**
 * Renders the exact PDF artifact buildReport wrote to disk -- fetched by
 * reportId, never regenerated here. The same URL is what the email
 * attachment step reads server-side (generateExcelPdfAttachment), so what's
 * shown here is byte-identical to what eventually gets sent.
 */
export function ReportPdfPreview({ reportId }: { reportId: string }) {
  return (
    <Card className="overflow-hidden p-0">
      <iframe
        title="Report PDF preview"
        src={getReportPdfUrl(reportId)}
        className="h-[80vh] w-full border-0 bg-white"
      />
    </Card>
  );
}
