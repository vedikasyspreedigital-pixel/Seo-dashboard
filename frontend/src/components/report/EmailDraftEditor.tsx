import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { isDraftEditable, parseRecipientsInput, resolveSaveButtonLabel } from './reportStatus';
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
}

export function EmailDraftEditor({ report, onSave, saving, disabled, justSaved }: Props) {
  const [subject, setSubject] = useState(report.emailSubject ?? '');
  const [body, setBody] = useState(report.emailBody ?? '');
  const [recipientsInput, setRecipientsInput] = useState((report.resolvedRecipients ?? []).join(', '));
  const [clickupTaskUrl, setClickupTaskUrl] = useState(report.resolvedClickupTaskUrl ?? '');

  // Reset local form state whenever the server-side draft actually changes
  // (Regenerate, a prior Save) -- not on every keystroke, since those never
  // touch `report`. A successful save updates `report` with exactly what
  // was just persisted, so this also re-syncs the form to the confirmed
  // saved values (not merely whatever was typed) right after Save Changes.
  useEffect(() => {
    setSubject(report.emailSubject ?? '');
    setBody(report.emailBody ?? '');
    setRecipientsInput((report.resolvedRecipients ?? []).join(', '));
    setClickupTaskUrl(report.resolvedClickupTaskUrl ?? '');
  }, [report.id, report.emailSubject, report.emailBody, report.resolvedRecipients, report.resolvedClickupTaskUrl]);

  const editable = isDraftEditable(report.status);
  const { recipients, invalid } = parseRecipientsInput(recipientsInput);
  const canSave = editable && !disabled && subject.trim().length > 0 && body.trim().length > 0 && invalid.length === 0;

  // Unsaved-changes tracking (FIX #4 section 8): purely derived from
  // comparing the live form to the last-known-persisted `report` -- no
  // extra state to keep in sync. Becomes false the instant a save succeeds,
  // since `report` (and therefore this comparison) updates to match.
  const isDirty =
    subject !== (report.emailSubject ?? '') ||
    body !== (report.emailBody ?? '') ||
    recipientsInput !== (report.resolvedRecipients ?? []).join(', ') ||
    clickupTaskUrl !== (report.resolvedClickupTaskUrl ?? '');
  const saveLabel = resolveSaveButtonLabel({ saving, justSaved, isDirty });

  return (
    <Card className="p-6">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Email draft</p>

      {!editable && (
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
          Read-only -- editing is only available while the report is pending approval.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Subject</label>
          <input
            type="text"
            value={subject}
            disabled={!editable}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-60"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Body</label>
          <textarea
            value={body}
            disabled={!editable}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="w-full resize-y rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-60"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Recipients (comma-separated)</label>
          <input
            type="text"
            value={recipientsInput}
            disabled={!editable}
            onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="ops@example.com, client@example.com"
            className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-60"
          />
          {invalid.length > 0 && (
            <p className="mt-1.5 text-xs font-medium text-rose-300">Not a valid email address: {invalid.join(', ')}</p>
          )}
          {editable && recipients.length === 0 && invalid.length === 0 && (
            <p className="mt-1.5 text-xs text-amber-300">No recipients -- approving and sending will fail without at least one.</p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">ClickUp task (delivers via its Email composer)</label>
          <input
            type="text"
            value={clickupTaskUrl}
            disabled={!editable}
            onChange={(e) => setClickupTaskUrl(e.target.value)}
            placeholder="https://app.clickup.com/t/xxxxxxx"
            className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-60"
          />
          <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">Optional -- if empty, sending falls back to whatever email provider is configured.</p>
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
