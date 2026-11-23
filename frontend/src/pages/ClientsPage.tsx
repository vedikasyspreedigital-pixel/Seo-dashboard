import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextInput, Textarea } from '../components/ui/TextInput';
import { EmptyState } from '../components/ui/EmptyState';
import { FilterPills } from '../components/ui/FilterPills';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Modal } from '../components/ui/Modal';
import { FormField } from '../components/ui/FormField';
import { InlineError } from '../components/ui/InlineError';
import { AlertPanel } from '../components/ui/AlertPanel';
import { PencilIcon, PlusIcon, PowerIcon, SettingsIcon, TrashIcon, UndoIcon, UploadIcon } from '../components/ui/icons';
import { BaselineUploadModal } from '../components/baselines/BaselineUploadModal';
import { ReportSettingsModal } from '../components/clients/ReportSettingsModal';
import { parseRecipientsInput } from '../components/report/reportStatus';
import { useSession } from '../context/SessionContext';
import { useActiveClient } from '../context/ClientContext';
import { activateClient, archiveClient, createClient, deactivateClient, getClientsForManagement, restoreClient, setClientReportType, updateClient } from '../api/client';
import { clientReportType, type ClientRecord, type ReportType } from '../api/types';

const FILTERS = ['All', 'Active', 'Inactive', 'Report not confirmed', 'Archived'] as const;
type Filter = (typeof FILTERS)[number];

interface ClientFormState {
  name: string;
  domain: string;
  clickupTaskId: string;
  clickupTaskUrl: string;
  notes: string;
  recipients: string;
  cc: string;
  domainReportTaskId: string;
}

const EMPTY_FORM: ClientFormState = { name: '', domain: '', clickupTaskId: '', clickupTaskUrl: '', notes: '', recipients: '', cc: '', domainReportTaskId: '' };

function clientStatusBadge(client: ClientRecord) {
  if (client.archivedAt) return <StatusBadge label="Archived" toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]" />;
  if (client.isActive) return <StatusBadge label="Active" toneClassName="bg-emerald-500/15 text-emerald-300" />;
  return <StatusBadge label="Inactive" toneClassName="bg-amber-500/10 text-amber-300" />;
}

const REPORT_TYPE_BADGES: Record<ReportType, { label: string; tone: string }> = {
  normal: { label: 'PDF report', tone: 'bg-sky-500/15 text-sky-300' },
  consolidated: { label: 'Consolidated', tone: 'bg-violet-500/15 text-violet-300' },
  unconfirmed: { label: 'Not confirmed', tone: 'bg-amber-500/15 text-amber-300' },
};

/** Previous-rank baseline upload status -- shows when the most recently
 * uploaded baseline was added, not the baseline's own date column (that's
 * the ranking data's date, not the upload date -- the two can differ when
 * someone uploads an older report). */
function baselineStatusBadge(client: ClientRecord) {
  if (!client.latestBaseline) return <StatusBadge label="No baseline" toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]" />;
  const uploadedLabel = new Date(client.latestBaseline.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return <StatusBadge label={`Uploaded ${uploadedLabel}`} toneClassName="bg-brand-500/15 text-brand-300" />;
}

export function ClientsPage() {
  const { activeWorkspace } = useSession();
  const { refetch: refetchDropdown } = useActiveClient();
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('All');

  const [formModal, setFormModal] = useState<{ mode: 'create' } | { mode: 'edit'; client: ClientRecord } | null>(null);
  const [form, setForm] = useState<ClientFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Same validation EmailDraftEditor's Recipients/Cc fields use -- flags a
  // malformed address before Save is even clickable, mirroring the
  // backend's own EMAIL_PATTERN check so a bad address never round-trips
  // to a 400 the user has to decode from an error banner.
  const { recipients: parsedRecipients, invalid: invalidRecipients } = parseRecipientsInput(form.recipients);
  const { recipients: parsedCc, invalid: invalidCc } = parseRecipientsInput(form.cc);
  const hasEmailErrors = invalidRecipients.length > 0 || invalidCc.length > 0;

  const [archiveTarget, setArchiveTarget] = useState<ClientRecord | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [baselineTarget, setBaselineTarget] = useState<ClientRecord | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<ClientRecord | null>(null);
  // Bulk report type (2026-11-23): tick clients, set them all at once.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // "Confirm the report type" notifications link here with ?reportSettings=<clientId>.
  const [searchParams, setSearchParams] = useSearchParams();

  function load() {
    if (!activeWorkspace) return;
    setLoading(true);
    getClientsForManagement(activeWorkspace.id, { includeArchived: true })
      .then(setClients)
      .finally(() => setLoading(false));
  }

  useEffect(load, [activeWorkspace]);

  useEffect(() => {
    const id = searchParams.get('reportSettings');
    if (!id || clients.length === 0) return;
    const target = clients.find((c) => c.id === id);
    if (target) setSettingsTarget(target);
    setSearchParams(
      (params) => {
        params.delete('reportSettings');
        return params;
      },
      { replace: true },
    );
  }, [searchParams, clients, setSearchParams]);

  const unconfirmedCount = useMemo(() => clients.filter((c) => !c.archivedAt && clientReportType(c) === 'unconfirmed').length, [clients]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (query && !c.name.toLowerCase().includes(query)) return false;
      if (filter === 'Active') return c.isActive && !c.archivedAt;
      if (filter === 'Inactive') return !c.isActive && !c.archivedAt;
      if (filter === 'Archived') return !!c.archivedAt;
      if (filter === 'Report not confirmed') return !c.archivedAt && clientReportType(c) === 'unconfirmed';
      return !c.archivedAt;
    });
  }, [clients, search, filter]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormModal({ mode: 'create' });
  }

  function openEdit(client: ClientRecord) {
    setForm({
      name: client.name,
      domain: client.domain ?? '',
      clickupTaskId: client.clickupTaskId ?? '',
      clickupTaskUrl: client.clickupTaskUrl ?? '',
      domainReportTaskId: client.domainReportTaskId ?? '',
      notes: client.notes ?? '',
      recipients: (client.recipients ?? []).join(', '),
      cc: (client.cc ?? []).join(', '),
    });
    setFormError(null);
    setFormModal({ mode: 'edit', client });
  }

  async function handleSubmitForm() {
    if (!activeWorkspace || !formModal || submitting) return;
    if (form.name.trim().length === 0) {
      setFormError('Name is required.');
      return;
    }
    if (hasEmailErrors) {
      setFormError('Fix the invalid email address(es) in Email To/Cc before saving.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (formModal.mode === 'create') {
        await createClient({
          workspaceId: activeWorkspace.id,
          name: form.name.trim(),
          domain: form.domain.trim() || undefined,
          clickupTaskId: form.clickupTaskId.trim() || undefined,
          clickupTaskUrl: form.clickupTaskUrl.trim() || undefined,
          domainReportTaskId: form.domainReportTaskId.trim() || undefined,
          notes: form.notes.trim() || undefined,
          recipients: parsedRecipients,
          cc: parsedCc,
        });
      } else {
        await updateClient(formModal.client.id, {
          name: form.name.trim(),
          domain: form.domain.trim(),
          clickupTaskId: form.clickupTaskId.trim(),
          clickupTaskUrl: form.clickupTaskUrl.trim(),
          domainReportTaskId: form.domainReportTaskId.trim(),
          notes: form.notes.trim(),
          recipients: parsedRecipients,
          cc: parsedCc,
        });
      }
      setFormModal(null);
      load();
      refetchDropdown();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBulkReportType(type: ReportType) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setRowActionError(null);
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await setClientReportType(id, type);
      } catch {
        failed.push(clients.find((c) => c.id === id)?.name ?? id);
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (failed.length) setRowActionError(`Couldn't change: ${failed.join(', ')} (inactive or archived clients can't be changed).`);
    load();
  }

  async function handleToggleActive(client: ClientRecord) {
    setRowActionError(null);
    try {
      if (client.isActive) await deactivateClient(client.id);
      else await activateClient(client.id);
      load();
      refetchDropdown();
    } catch (err) {
      setRowActionError((err as Error).message);
    }
  }

  async function handleConfirmArchive() {
    if (!archiveTarget || archiving) return;
    setArchiving(true);
    setRowActionError(null);
    try {
      await archiveClient(archiveTarget.id);
      setArchiveTarget(null);
      load();
      refetchDropdown();
    } catch (err) {
      setRowActionError((err as Error).message);
    } finally {
      setArchiving(false);
    }
  }

  async function handleRestore(client: ClientRecord) {
    setRowActionError(null);
    try {
      await restoreClient(client.id);
      load();
    } catch (err) {
      setRowActionError((err as Error).message);
    }
  }

  return (
    <AppShell wide>
      <PageHeader
        breadcrumbs={[{ label: 'Client Management' }]}
        action={
          <Button onClick={openCreate}>
            <PlusIcon className="h-4 w-4" />
            Add Client
          </Button>
        }
      />
      <PageTitle title="Client Management" subtitle={activeWorkspace ? `${activeWorkspace.name} · ${clients.length} client${clients.length === 1 ? '' : 's'} total` : undefined} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <FilterPills options={FILTERS} value={filter} onChange={setFilter} />
        <div className="w-64">
          <TextInput type="search" placeholder="Search clients..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {unconfirmedCount > 0 && filter !== 'Report not confirmed' && (
        <AlertPanel tone="warning" className="mt-4 flex flex-wrap items-center justify-between gap-3 !py-3">
          <p className="text-sm text-amber-200">
            <span className="font-semibold">
              {unconfirmedCount} client{unconfirmedCount === 1 ? '' : 's'}
            </span>{' '}
            {unconfirmedCount === 1 ? 'has' : 'have'} no confirmed report type (normal PDF or consolidated Excel). You'll get a notification after each of
            their runs until it's set.
          </p>
          <Button variant="secondary" className="!py-1.5 text-xs" onClick={() => setFilter('Report not confirmed')}>
            Review them
          </Button>
        </AlertPanel>
      )}

      {selected.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand-400/30 bg-brand-400/[0.06] px-4 py-3 text-sm">
          <span className="font-semibold text-[var(--color-ink)]">{selected.size} selected</span>
          <span className="text-[var(--color-ink-muted)]">Set report type:</span>
          {(['normal', 'consolidated', 'unconfirmed'] as ReportType[]).map((t) => (
            <Button key={t} variant="secondary" className="!py-1.5 text-xs" disabled={bulkBusy} onClick={() => void handleBulkReportType(t)}>
              {t === 'normal' ? 'Normal PDF' : t === 'consolidated' ? 'Consolidated' : 'Not confirmed'}
            </Button>
          ))}
          <button type="button" className="ml-auto text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <InlineError message={rowActionError} className="mt-4" />

      <Card className="mt-4 overflow-hidden p-0">
        {loading ? (
          <EmptyState label="Loading..." />
        ) : filtered.length === 0 ? (
          <EmptyState label={clients.length === 0 ? 'No clients yet for this workspace.' : 'No clients match your search/filter.'} />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] eyebrow-label">
                <th className="cell-compact w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all shown clients"
                    className="h-4 w-4 accent-[var(--color-brand,#8b5cf6)]"
                    checked={filtered.length > 0 && filtered.filter((c) => !c.archivedAt).every((c) => selected.has(c.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(filtered.filter((c) => !c.archivedAt).map((c) => c.id)) : new Set())}
                  />
                </th>
                <th className="cell-compact">Client</th>
                <th className="cell-compact">Report</th>
                <th className="cell-compact">Status</th>
                <th className="cell-compact">Previous Rank</th>
                <th className="cell-compact">ClickUp Task ID</th>
                <th className="cell-compact">Notes</th>
                <th className="cell-compact" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((client) => (
                <tr key={client.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="cell-cozy">
                    {!client.archivedAt && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${client.name}`}
                        className="h-4 w-4 accent-[var(--color-brand,#8b5cf6)]"
                        checked={selected.has(client.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (next.has(client.id)) next.delete(client.id);
                            else next.add(client.id);
                            return next;
                          })
                        }
                      />
                    )}
                  </td>
                  <td className="cell-cozy">
                    <Link to={`/clients/${client.id}`} className="block font-medium text-[var(--color-ink)] hover:text-brand-200">
                      {client.name}
                    </Link>
                    {client.domain && <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">{client.domain}</span>}
                  </td>
                  <td className="cell-cozy">
                    {client.archivedAt ? (
                      <StatusBadge label={REPORT_TYPE_BADGES[clientReportType(client)].label} toneClassName={REPORT_TYPE_BADGES[clientReportType(client)].tone} />
                    ) : (
                      <button type="button" title="Report settings" onClick={() => setSettingsTarget(client)} className="rounded-full transition-opacity hover:opacity-80">
                        <StatusBadge label={REPORT_TYPE_BADGES[clientReportType(client)].label} toneClassName={REPORT_TYPE_BADGES[clientReportType(client)].tone} />
                      </button>
                    )}
                  </td>
                  <td className="cell-cozy">{clientStatusBadge(client)}</td>
                  <td className="cell-cozy">{baselineStatusBadge(client)}</td>
                  <td className="cell-cozy font-mono text-xs text-[var(--color-ink-muted)]">{client.clickupTaskId ?? '—'}</td>
                  <td className="cell-cozy max-w-[11rem] truncate text-[var(--color-ink-muted)]" title={client.notes ?? undefined}>
                    {client.notes ?? '—'}
                  </td>
                  <td className="cell-cozy">
                    <div className="flex items-center justify-end gap-2">
                      {client.archivedAt ? (
                        <button type="button" title="Restore" onClick={() => handleRestore(client)} className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-overlay/[0.06] hover:text-[var(--color-ink)]">
                          <UndoIcon className="h-4 w-4" />
                        </button>
                      ) : (
                        <>
                          <button type="button" title="Edit" onClick={() => openEdit(client)} className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-overlay/[0.06] hover:text-[var(--color-ink)]">
                            <PencilIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Upload Previous Ranking"
                            onClick={() => setBaselineTarget(client)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-overlay/[0.06] hover:text-[var(--color-ink)]"
                          >
                            <UploadIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Report settings"
                            onClick={() => setSettingsTarget(client)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-overlay/[0.06] hover:text-[var(--color-ink)]"
                          >
                            <SettingsIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title={client.isActive ? 'Deactivate' : 'Activate'}
                            onClick={() => handleToggleActive(client)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-overlay/[0.06] hover:text-[var(--color-ink)]"
                          >
                            <PowerIcon className="h-4 w-4" />
                          </button>
                          <button type="button" title="Delete" onClick={() => setArchiveTarget(client)} className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-rose-500/10 hover:text-rose-300">
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <Modal
        open={formModal !== null}
        onClose={() => setFormModal(null)}
        title={formModal?.mode === 'edit' ? 'Edit Client' : 'Add Client'}
        closeOnBackdropClick={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormModal(null)}>
              Cancel
            </Button>
            <Button disabled={submitting || hasEmailErrors} onClick={handleSubmitForm}>
              {submitting ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Client name">
            <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          </FormField>
          <FormField label="Domain">
            <TextInput value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} placeholder="example.com" />
          </FormField>
          <FormField label="Email To (comma-separated)">
            <TextInput value={form.recipients} onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} placeholder="ops@example.com, client@example.com" />
            {invalidRecipients.length > 0 && (
              <p className="mt-1.5 text-xs font-medium text-rose-300">Not a valid email address: {invalidRecipients.join(', ')}</p>
            )}
          </FormField>
          <FormField label="Email CC (comma-separated, optional)">
            <TextInput value={form.cc} onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))} placeholder="manager@example.com" />
            {invalidCc.length > 0 && (
              <p className="mt-1.5 text-xs font-medium text-rose-300">Not a valid email address: {invalidCc.join(', ')}</p>
            )}
          </FormField>
          <FormField label="ClickUp Task ID">
            <TextInput value={form.clickupTaskId} onChange={(e) => setForm((f) => ({ ...f, clickupTaskId: e.target.value }))} placeholder="86d45e14k" />
          </FormField>
          <FormField label="ClickUp Task URL (fallback)">
            <TextInput value={form.clickupTaskUrl} onChange={(e) => setForm((f) => ({ ...f, clickupTaskUrl: e.target.value }))} placeholder="https://app.clickup.com/t/xxxxxxx" />
          </FormField>
          <FormField label="Domain report ClickUp Task ID">
            <TextInput value={form.domainReportTaskId} onChange={(e) => setForm((f) => ({ ...f, domainReportTaskId: e.target.value }))} placeholder="Task that receives Domain Intelligence reports" />
          </FormField>
          <FormField label="Internal notes" error={formError}>
            <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={3} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        title="Delete client"
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={archiving} onClick={handleConfirmArchive}>
              {archiving ? 'Deleting...' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--color-ink-muted)]">
          This archives <span className="font-semibold text-[var(--color-ink)]">{archiveTarget?.name}</span> -- it disappears from this list and from run/report dropdowns, but every existing run and report stays intact and can be restored later from the Archived filter.
        </p>
      </Modal>

      {baselineTarget && (
        <BaselineUploadModal
          open={baselineTarget !== null}
          clientId={baselineTarget.id}
          onClose={() => setBaselineTarget(null)}
          onConfirmed={load}
        />
      )}

      {settingsTarget && (
        <ReportSettingsModal
          clientId={settingsTarget.id}
          clientName={settingsTarget.name}
          onClose={() => setSettingsTarget(null)}
          onChanged={load}
        />
      )}
    </AppShell>
  );
}
