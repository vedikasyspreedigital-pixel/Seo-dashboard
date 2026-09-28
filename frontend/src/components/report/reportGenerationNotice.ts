import type { ReportGenerationSummary } from '../../api/client';

/** Router state passed to the Analytics page after a (re)generation, so it can say what just happened. */
export interface ReportGenerationNoticeState {
  generationNotice?: string;
}

/** One plain sentence describing what an upload / Regenerate just did. */
export function describeReportGeneration(summary: ReportGenerationSummary): string {
  if (!summary.regenerated) return 'Report created. Review it below — you can upload an updated Excel or regenerate any time before sending.';
  if (summary.rowsChanged === null) return 'Report regenerated with today’s date.';
  if (summary.rowsChanged === 0) return 'Report rebuilt — no ranks changed since your last upload.';
  return `Report updated — ${summary.rowsChanged} keyword${summary.rowsChanged === 1 ? '' : 's'} changed since your last upload.`;
}
