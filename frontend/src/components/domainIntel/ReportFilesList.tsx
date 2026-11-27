import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { WorkbookPreviewModal } from '../ui/WorkbookPreviewModal';
import {
  downloadDomainReportFile,
  openDomainReportPdf,
  previewDomainReportFile,
  replaceDomainReportFile,
  type DomainReport,
} from '../../api/client';

/**
 * A domain report's files, one row each (2026-11-27): Preview, Download, and -- until it's posted -- Upload a
 * changed copy, the way the verified rankings are uploaded. Nothing reaches ClickUp until the team presses Post.
 */
export function ReportFilesList({
  report,
  onChanged,
  onError,
}: {
  report: Pick<DomainReport, 'id' | 'status' | 'files'>;
  onChanged: (updated: DomainReport) => void;
  onError: (message: string) => void;
}) {
  const [previewing, setPreviewing] = useState<{ index: number; name: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const canChange = report.status === 'READY' || report.status === 'NOT_POSTED' || report.status === 'POST_FAILED' || report.status === 'GENERATED';

  async function preview(index: number, name: string) {
    if (!name.toLowerCase().endsWith('.pdf')) {
      setPreviewing({ index, name });
      return;
    }
    // A PDF opens in a new tab. The tab is opened first (a pop-up blocker allows it on the click), then filled.
    const tab = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(await openDomainReportPdf(report.id, index));
      if (tab) tab.location.href = url;
      else window.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      onError((err as Error).message);
    }
  }

  async function download(index: number, name: string) {
    try {
      const url = URL.createObjectURL(await downloadDomainReportFile(report.id, index));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function replace(index: number, file: File | undefined) {
    if (!file) return;
    setBusy(index);
    try {
      onChanged(await replaceDomainReportFile(report.id, index, file));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
      const input = inputs.current[index];
      if (input) input.value = '';
    }
  }

  if (report.files.length === 0) return null;
  return (
    <>
      <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]" aria-label="Files">
        {report.files.map((f, i) => {
          const ext = f.name.toLowerCase().endsWith('.pdf') ? '.pdf' : '.xlsx';
          return (
            <li key={`${f.name}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-ink)]" title={f.name}>
                {f.name}
              </span>
              {f.editedAt && (
                <span className="whitespace-nowrap text-[11px] text-emerald-300" title={new Date(f.editedAt).toLocaleString()}>
                  ✓ Changed copy{f.editedBy ? ` · ${f.editedBy}` : ''}
                </span>
              )}
              <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => void preview(i, f.name)}>
                Preview
              </Button>
              <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => void download(i, f.name)}>
                Download
              </Button>
              {canChange && (
                <>
                  <input
                    ref={(el) => {
                      inputs.current[i] = el;
                    }}
                    type="file"
                    accept={ext}
                    className="hidden"
                    aria-label={`Upload a changed copy of ${f.name}`}
                    onChange={(e) => void replace(i, e.target.files?.[0])}
                  />
                  <Button variant="secondary" className="!px-2.5 !py-1 text-xs" disabled={busy !== null} onClick={() => inputs.current[i]?.click()}>
                    {busy === i ? 'Uploading…' : 'Upload changed'}
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <WorkbookPreviewModal title={previewing?.name ?? null} load={() => previewDomainReportFile(report.id, previewing!.index)} onClose={() => setPreviewing(null)} />
    </>
  );
}
