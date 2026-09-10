import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { TextInput, Textarea } from '../ui/TextInput';
import { isDraftEditable, parseRecipientsInput, resolveSaveButtonLabel } from './reportStatus';
import { updateReportDraft, uploadCustomPdf } from '../../api/client';
import type { RankingReport } from '../../api/types';
import type { UpdateReportDraftInput } from '../../api/client';

interface Props {
  report: RankingReport;
  onSave: (edits: UpdateReportDraftInput) => void;
  /** True specifically while THIS save request is in flight -- drives the button's own "Saving..." label, never set by a sibling action (Regenerate/Reject). */
  saving: boolean;
  /** True while ANY report action is in flight (this save, or Regenerate/Reject) -- prevents firing a save concurrently with a different in-flight action. */
  disabled: boolean;
  /** True right after a successful Save Changes call, until the user edits anything else. */
  justSaved: boolean;
  /** Called after the attachment choice (radio switch or upload) is confirmed persisted server-side -- separate from onSave/handleSave since both take effect immediately rather than going through the shared Save Changes button. */
  onReportUpdated: (report: RankingReport) => void;
}

export function EmailDraftEditor({ report, onSave, saving, disabled, justSaved, onReportUpdated }: Props) {
  const [subject, setSubject] = useState(report.emailSubject ?? '');
  const [body, setBody] = useState(report.emailBody ?? '');
  const [recipientsInput, setRecipientsInput] = useState((report.resolvedRecipients ?? []).join(', '));
  const [ccInput, setCcInput] = useState((report.resolvedCc ?? []).join(', '));
  const [clickupTaskUrl, setClickupTaskUrl] = useState(report.resolvedClickupTaskUrl ?? '');
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Purely a UI reveal flag for the file picker -- deliberately separate
  // from report.attachmentSource, which only changes once a file actually
  // finishes uploading (or the user switches back to "generated"). Without
  // this, the file picker had no way to show up BEFORE a file existed:
  // clicking "Upload custom PDF" needs to reveal "Choose File" immediately,
  // not wait for a round-trip that hasn't happened yet.
  const [attachmentMode, setAttachmentMode] = useState<'generated' | 'custom'>(report.attachmentSource === 'custom' ? 'custom' : 'generated');

  // Reset local form state whenever the server-side draft actually changes
  // (Regenerate, a prior Save) -- not on every keystroke, since those never
  // touch `report`. A successful save updates `report` with exactly what
  // was just persisted, so this also re-syncs the form to the confirmed
  // saved values (not merely whatever was typed) right after Save Changes.
  useEffect(() => {
    setSubject(report.emailSubject ?? '');
    setBody(report.emailBody ?? '');
    setRecipientsInput((report.resolvedRecipients ?? []).join(', '));
    setCcInput((report.resolvedCc ?? []).join(', '));
    setClickupTaskUrl(report.resolvedClickupTaskUrl ?? '');
    setAttachmentMode(report.attachmentSource === 'custom' ? 'custom' : 'generated');
  }, [report.id, report.emailSubject, report.emailBody, report.resolvedRecipients, report.resolvedCc, report.resolvedClickupTaskUrl, report.attachmentSource]);

  const editable = isDraftEditable(report.status);
  const { recipients, invalid } = parseRecipientsInput(recipientsInput);
  // Cc is optional -- an empty Cc field is always valid, only malformed
  // addresses within it are rejected, same rule as Recipients.
  const { recipients: cc, invalid: invalidCc } = parseRecipientsInput(ccInput);
  const canSave = editable && !disabled && subject.trim().length > 0 && body.trim().length > 0 && invalid.length === 0 && invalidCc.length === 0;

  // Unsaved-changes tracking (FIX #4 section 8): purely derived from
  // comparing the live form to the last-known-persisted `report` -- no
  // extra state to keep in sync. Becomes false the instant a save succeeds,
  // since `report` (and therefore this comparison) updates to match.
  const isDirty =
    subject !== (report.emailSubject ?? '') ||
    body !== (report.emailBody ?? '') ||
    recipientsInput !== (report.resolvedRecipients ?? []).join(', ') ||
    ccInput !== (report.resolvedCc ?? []).join(', ') ||
    clickupTaskUrl !== (report.resolvedClickupTaskUrl ?? '');
  const saveLabel = resolveSaveButtonLabel({ saving, justSaved, isDirty });

  async function handleSelectGenerated() {
    setAttachmentMode('generated'); // always reflect the click locally, even if there's nothing to persist yet
    if (!editable || disabled || report.attachmentSource === 'generated') return;
    setAttachmentError(null);
    try {
      const updated = await updateReportDraft(report.id, { attachmentSource: 'generated' });
      onReportUpdated(updated);
    } catch (err) {
      setAttachmentError((err as Error).message);
    }
  }

  async function handleUploadCustomPdf(file: File) {
    if (!editable || disabled) return;
    setAttachmentError(null);
    setUploadingPdf(true);
    try {
      const updated = await uploadCustomPdf(report.id, file);
      onReportUpdated(updated);
    } catch (err) {
      setAttachmentError((err as Error).message);
    } finally {
      setUploadingPdf(false);
    }
  }

  return (
    <Card className="p-6">
      <p className="eyebrow-label">Email draft</p>

      {!editable && (
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
          Read-only -- editing is only available while the report is pending approval.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Subject</label>
          <TextInput type="text" value={subject} disabled={!editable} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Body</label>
          <Textarea value={body} disabled={!editable} onChange={(e) => setBody(e.target.value)} rows={6} />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Recipients (comma-separated)</label>
          <TextInput
            type="text"
            value={recipientsInput}
            disabled={!editable}
            onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="ops@example.com, client@example.com"
          />
          {invalid.length > 0 && (
            <p className="mt-1.5 text-xs font-medium text-rose-300">Not a valid email address: {invalid.join(', ')}</p>
          )}
          {editable && recipients.length === 0 && invalid.length === 0 && (
            <p className="mt-1.5 text-xs text-amber-300">No recipients -- approving and sending will fail without at least one.</p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Cc (comma-separated, optional)</label>
          <TextInput
            type="text"
            value={ccInput}
            disabled={!editable}
            onChange={(e) => setCcInput(e.target.value)}
            placeholder="manager@example.com"
          />
          {invalidCc.length > 0 && (
            <p className="mt-1.5 text-xs font-medium text-rose-300">Not a valid email address: {invalidCc.join(', ')}</p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">ClickUp task (delivers via its Email composer)</label>
          <TextInput
            type="text"
            value={clickupTaskUrl}
            disabled={!editable}
            onChange={(e) => setClickupTaskUrl(e.target.value)}
            placeholder="https://app.clickup.com/t/xxxxxxx"
          />
          <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">Optional -- if empty, sending falls back to whatever email provider is configured.</p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Attachment</label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
              <input
                type="radio"
                name={`attachment-source-${report.id}`}
                checked={attachmentMode === 'generated'}
                disabled={!editable || disabled}
                onChange={handleSelectGenerated}
              />
              Use generated report PDF
              {report.clientPdfPath && <span className="text-[var(--color-ink-faint)]">(Report-{report.id.slice(0, 8)}.pdf)</span>}
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
              <input
                type="radio"
                name={`attachment-source-${report.id}`}
                checked={attachmentMode === 'custom'}
                disabled={!editable || disabled}
                onChange={() => setAttachmentMode('custom')}
              />
              Upload custom PDF
              {report.attachmentSource === 'custom' && report.customPdfFilename && (
                <span className="text-[var(--color-ink-faint)]">({report.customPdfFilename})</span>
              )}
            </label>
            {editable && attachmentMode === 'custom' && (
              <div className="ml-6">
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={disabled || uploadingPdf}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUploadCustomPdf(file);
                    e.target.value = '';
                  }}
                  className="text-xs text-[var(--color-ink-faint)]"
                />
                {uploadingPdf && <span className="ml-2 text-xs text-[var(--color-ink-faint)]">Uploading...</span>}
              </div>
            )}
            {attachmentError && <p className="text-xs font-medium text-rose-300">{attachmentError}</p>}
          </div>
        </div>

        {editable && (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={!canSave}
              onClick={() =>
                onSave({
                  emailSubject: subject,
                  emailBody: body,
                  resolvedRecipients: recipients,
                  resolvedCc: cc,
                  resolvedClickupTaskUrl: clickupTaskUrl.trim() || null,
                })
              }
            >
              {saving && <Spinner />}
              {saveLabel}
            </Button>
            {!saving && isDirty && <span className="text-xs font-medium text-amber-300">Unsaved changes</span>}
            {!saving && !isDirty && justSaved && <span className="text-xs font-medium text-brand-300">Changes saved</span>}
          </div>
        )}
      </div>
    </Card>
  );
}
