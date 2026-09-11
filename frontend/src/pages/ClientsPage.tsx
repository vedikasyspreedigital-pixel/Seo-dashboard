import { useEffect, useMemo, useState } from 'react';
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
import { PencilIcon, PlusIcon, PowerIcon, TrashIcon, UndoIcon, UploadDropIcon } from '../components/ui/icons';
import { BaselineUploadModal } from '../components/baselines/BaselineUploadModal';
import { useSession } from '../context/SessionContext';
import { useActiveClient } from '../context/ClientContext';
import { activateClient, archiveClient, createClient, deactivateClient, getClientsForManagement, restoreClient, updateClient } from '../api/client';
import type { ClientRecord } from '../api/types';

const FILTERS = ['All', 'Active', 'Inactive', 'Archived'] as const;
type Filter = (typeof FILTERS)[number];

interface ClientFormState {
  name: string;
  clickupTaskId: string;
  clickupTaskUrl: string;
  notes: string;
}

const EMPTY_FORM: ClientFormState = { name: '', clickupTaskId: '', clickupTaskUrl: '', notes: '' };

function clientStatusBadge(client: ClientRecord) {
  if (client.archivedAt) return <StatusBadge label="Archived" toneClassName="bg-[var(--color-surface-3)] text-[var(--color-ink-faint)]" />;
  if (client.isActive) return <StatusBadge label="Active" toneClassName="bg-emerald-500/15 text-emerald-300" />;
  return <StatusBadge label="Inactive" toneClassName="bg-amber-500/10 text-amber-300" />;
}

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

  const [archiveTarget, setArchiveTarget] = useState<ClientRecord | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [baselineTarget, setBaselineTarget] = useState<ClientRecord | null>(null);

  function load() {
    if (!activeWorkspace) return;
    setLoading(true);
    getClientsForManagement(activeWorkspace.id, { includeArchived: true })
      .then(setClients)
      .finally(() => setLoading(false));
  }

  useEffect(load, [activeWorkspace]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (query && !c.name.toLowerCase().includes(query)) return false;
      if (filter === 'Active') return c.isActive && !c.archivedAt;
      if (filter === 'Inactive') return !c.isActive && !c.archivedAt;
      if (filter === 'Archived') return !!c.archivedAt;
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
      clickupTaskId: client.clickupTaskId ?? '',
      clickupTaskUrl: client.clickupTaskUrl ?? '',
      notes: client.notes ?? '',
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
    setSubmitting(true);
    setFormError(null);
    try {
      if (formModal.mode === 'create') {
        await createClient({
          workspaceId: activeWorkspace.id,
          name: form.name.trim(),
          clickupTaskId: form.clickupTaskId.trim() || undefined,
          clickupTaskUrl: form.clickupTaskUrl.trim() || undefined,
          notes: form.notes.trim() || undefined,
        });
      } else {
        await updateClient(formModal.client.id, {
          name: form.name.trim(),
          clickupTaskId: form.clickupTaskId.trim(),
          clickupTaskUrl: form.clickupTaskUrl.trim(),
          notes: form.notes.trim(),
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
    <AppShell>
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

      <InlineError message={rowActionError} className="mt-4" />

      <Card className="mt-4 overflow-hidden p-0">
        {loading ? (
          <EmptyState label="Loading..." />
        ) : filtered.length === 0 ? (
          <EmptyState label={clients.length === 0 ? 'No clients yet for this workspace.' : 'No clients match your search/filter.'} />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] eyebrow-label">
                <th className="cell-compact">Name</th>
                <th className="cell-compact">ClickUp Task ID</th>
                <th className="cell-compact">Status</th>
                <th className="cell-compact">Previous Rank</th>
                <th className="cell-compact">Notes</th>
                <th className="cell-compact" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((client) => (
                <tr key={client.id} className="border-b border-[var(--color-border)] last:border-0 even:bg-[var(--color-surface-2)]/40">
                  <td className="cell-cozy text-[var(--color-ink)]">{client.name}</td>
                  <td className="cell-cozy font-mono text-[var(--color-ink-muted)]">{client.clickupTaskId ?? '—'}</td>
                  <td className="cell-cozy">{clientStatusBadge(client)}</td>
                  <td className="cell-cozy">{baselineStatusBadge(client)}</td>
                  <td className="cell-cozy max-w-xs truncate text-[var(--color-ink-muted)]" title={client.notes ?? undefined}>
                    {client.notes ?? '—'}
                  </td>
                  <td className="cell-cozy">
                    <div className="flex items-center justify-end gap-2">
                      {client.archivedAt ? (
                        <button type="button" title="Restore" onClick={() => handleRestore(client)} className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]">
                          <UndoIcon className="h-4 w-4" />
                        </button>
                      ) : (
                        <>
                          <button type="button" title="Edit" onClick={() => openEdit(client)} className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]">
                            <PencilIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Upload Previous Ranking"
                            onClick={() => setBaselineTarget(client)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]"
                          >
                            <UploadDropIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title={client.isActive ? 'Deactivate' : 'Activate'}
                            onClick={() => handleToggleActive(client)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-white/[0.06] hover:text-[var(--color-ink)]"
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
        )}
      </Card>

      <Modal
        open={formModal !== null}
        onClose={() => setFormModal(null)}
        title={formModal?.mode === 'edit' ? 'Edit Client' : 'Add Client'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormModal(null)}>
              Cancel
            </Button>
            <Button disabled={submitting} onClick={handleSubmitForm}>
              {submitting ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Client name">
            <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          </FormField>
          <FormField label="ClickUp Task ID">
            <TextInput value={form.clickupTaskId} onChange={(e) => setForm((f) => ({ ...f, clickupTaskId: e.target.value }))} placeholder="86d45e14k" />
          </FormField>
          <FormField label="ClickUp Task URL (fallback)">
            <TextInput value={form.clickupTaskUrl} onChange={(e) => setForm((f) => ({ ...f, clickupTaskUrl: e.target.value }))} placeholder="https://app.clickup.com/t/xxxxxxx" />
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
    </AppShell>
  );
}
