import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader, PageTitle } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { FormField } from '../components/ui/FormField';
import { TextInput } from '../components/ui/TextInput';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { InlineError } from '../components/ui/InlineError';
import { StatusBadge } from '../components/ui/StatusBadge';
import { AlertPanel } from '../components/ui/AlertPanel';
import { EmptyState } from '../components/ui/EmptyState';
import { PlusIcon, TrashIcon } from '../components/ui/icons';
import { useSession } from '../context/SessionContext';
import { bookRunSlot, checkRunSlotClashes, deleteRunSlot, getClients, getRunSlots, startRunSlot } from '../api/client';
import type { ClientRecord, RunSlot, RunSlotClash, RunSlotStartResult } from '../api/types';

const DURATIONS = [
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
  { value: '360', label: 'Half day (6 hours)' },
];
const REPEATS = [
  { value: 'once', label: 'Once' },
  { value: '7', label: 'Every week' },
  { value: '15', label: 'Every 15 days' },
];

const STATE_BADGE: Record<RunSlot['state'], { label: string; tone: string }> = {
  upcoming: { label: 'Upcoming', tone: 'bg-[var(--color-surface-3)] text-[var(--color-ink-muted)]' },
  open: { label: 'Now', tone: 'bg-amber-500/15 text-amber-300' },
  started: { label: 'Started', tone: 'bg-emerald-500/15 text-emerald-300' },
  missed: { label: 'Missed', tone: 'bg-rose-500/10 text-rose-300' },
};

function dayLabel(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
function timeRange(start: Date, minutes: number) {
  const end = new Date(start.getTime() + minutes * 60_000);
  const t = (x: Date) => x.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${t(start)} – ${t(end)}`;
}
function localInputDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Run slots (2026-11-23): each team books when its runs go, so SEO and Advanced SEO don't overlap. Both teams'
 * slots are on one list. At the slot's time the team gets a reminder; "Start all" puts every client's run in the
 * shared run queue (the fresh upload if there is one, else the last keyword list again). Urgent runs can still
 * jump the queue from a run's own page.
 */
export function RunSlotsPage() {
  const { activeWorkspace } = useSession();
  const [slots, setSlots] = useState<RunSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunSlotStartResult>>({});

  function load() {
    getRunSlots()
      .then((s) => {
        setSlots(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }
  useEffect(load, []);

  const byDay = useMemo(() => {
    const groups = new Map<string, RunSlot[]>();
    for (const s of slots ?? []) {
      const key = dayLabel(new Date(s.startsAt));
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return [...groups.entries()];
  }, [slots]);

  async function handleStart(slot: RunSlot) {
    const n = slot.clientCount ?? 0;
    if (!window.confirm(`Start runs for ${n} client${n === 1 ? '' : 's'} now? Each one goes into the run queue and uses rank-check credits.`)) return;
    setStarting(slot.id);
    setError(null);
    try {
      const result = await startRunSlot(slot.id);
      setResults((r) => ({ ...r, [slot.id]: result }));
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(null);
    }
  }

  async function handleDelete(slot: RunSlot) {
    if (!window.confirm(`Remove this slot (${dayLabel(new Date(slot.startsAt))}, ${timeRange(new Date(slot.startsAt), slot.durationMinutes)})?`)) return;
    try {
      await deleteRunSlot(slot.id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumbs={[{ label: 'Run slots' }]}
        action={
          <Button onClick={() => setBooking(true)} disabled={!activeWorkspace}>
            <PlusIcon className="h-4 w-4" />
            Book a slot
          </Button>
        }
      />
      <PageTitle
        title="Run slots"
        subtitle="When each team runs its clients. Both teams see every slot, so runs don't pile up at the same time."
      />

      <InlineError message={error} className="mt-4" />

      <Card className="mt-6 overflow-hidden p-0">
        {!slots ? (
          <EmptyState label="Loading..." />
        ) : slots.length === 0 ? (
          <EmptyState label="No slots booked yet." hint="Book one for your team, e.g. Friday 10 AM – 1 PM, every 15 days." />
        ) : (
          byDay.map(([day, list]) => (
            <div key={day} className="border-b border-[var(--color-border)] last:border-0">
              <p className="eyebrow-label px-6 pt-4">{day}</p>
              <ul>
                {list.map((slot) => {
                  const start = new Date(slot.startsAt);
                  const badge = STATE_BADGE[slot.state];
                  const result = results[slot.id] ?? (slot.lastResult && slot.state === 'started' ? slot.lastResult : null);
                  return (
                    <li key={slot.id} className={`px-6 py-4 ${slot.own ? '' : 'opacity-80'}`}>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="w-40 shrink-0 font-mono text-sm text-[var(--color-ink)]">{timeRange(start, slot.durationMinutes)}</span>
                        <span className="min-w-0 flex-1">
                          <span className={`font-semibold ${slot.own ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}>{slot.workspaceName}</span>
                          <span className="ml-2 text-sm text-[var(--color-ink-faint)]">
                            {slot.own
                              ? `${slot.allClients ? 'All active clients' : 'Picked clients'} (${slot.clientCount ?? 0})`
                              : 'other team'}
                            {slot.repeatDays ? ` · every ${slot.repeatDays === 7 ? 'week' : `${slot.repeatDays} days`}` : ''}
                            {slot.note ? ` · ${slot.note}` : ''}
                          </span>
                        </span>
                        <StatusBadge label={badge.label} toneClassName={badge.tone} />
                        {slot.own && slot.state !== 'started' && (
                          <Button variant={slot.state === 'open' ? 'primary' : 'secondary'} className="!py-1.5 text-xs" disabled={starting !== null} onClick={() => void handleStart(slot)}>
                            {starting === slot.id && <Spinner />}
                            {slot.state === 'open' ? 'Start all' : 'Start now'}
                          </Button>
                        )}
                        {slot.own && (
                          <button
                            type="button"
                            title="Remove slot"
                            onClick={() => void handleDelete(slot)}
                            className="rounded-full p-1.5 text-[var(--color-ink-muted)] hover:bg-rose-500/10 hover:text-rose-300"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      {slot.state === 'started' && slot.startedBy && (
                        <p className="mt-1.5 pl-44 text-xs text-[var(--color-ink-faint)]">
                          Started by {slot.startedBy}
                          {slot.startedAt ? ` at ${new Date(slot.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}.{' '}
                          <Link to="/runs" className="text-brand-300 hover:text-brand-200">
                            See the run queue
                          </Link>
                        </p>
                      )}
                      {result && <SlotResult result={result} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </Card>

      {booking && activeWorkspace && (
        <BookSlotModal
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          onClose={() => setBooking(false)}
          onBooked={() => {
            setBooking(false);
            load();
          }}
        />
      )}
    </AppShell>
  );
}

function SlotResult({ result }: { result: RunSlotStartResult }) {
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm sm:ml-44">
      <p className="text-emerald-300">
        {result.queued.length} run{result.queued.length === 1 ? '' : 's'} in the queue
        {result.queued.some((q) => q.reused) ? ` (${result.queued.filter((q) => q.reused).length} using last time's keywords)` : ''}.
      </p>
      {result.skipped.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-amber-300">
          {result.skipped.map((s) => (
            <li key={s.clientId}>
              {s.clientName}: {s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BookSlotModal({ workspaceId, workspaceName, onClose, onBooked }: { workspaceId: string; workspaceName: string; onClose: () => void; onBooked: () => void }) {
  const [date, setDate] = useState(localInputDate(new Date()));
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState('180');
  const [repeat, setRepeat] = useState('once');
  const [allClients, setAllClients] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [clashes, setClashes] = useState<RunSlotClash[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getClients(workspaceId)
      .then(setClients)
      .catch(() => setClients([]));
  }, [workspaceId]);

  const startsAt = useMemo(() => {
    const d = new Date(`${date}T${time}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, time]);

  useEffect(() => {
    if (!startsAt) return;
    let cancelled = false;
    checkRunSlotClashes(workspaceId, startsAt.toISOString(), Number(duration))
      .then((c) => {
        if (!cancelled) setClashes(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, startsAt, duration]);

  async function save() {
    if (!startsAt) return;
    setSaving(true);
    setError(null);
    try {
      await bookRunSlot({
        workspaceId,
        startsAt: startsAt.toISOString(),
        durationMinutes: Number(duration),
        repeatDays: repeat === 'once' ? null : Number(repeat),
        clientIds: allClients ? [] : [...picked],
        note: note.trim() || undefined,
      });
      onBooked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      open
      onClose={() => !saving && onClose()}
      closeOnBackdropClick={false}
      title={`Book a run slot · ${workspaceName}`}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !startsAt || (!allClients && picked.size === 0)} onClick={() => void save()}>
            {saving && <Spinner />}
            Book slot
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Date">
            <TextInput type="date" value={date} min={localInputDate(new Date())} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Start time">
            <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Length">
            <Select options={DURATIONS} value={duration} onChange={setDuration} placeholder="Length" />
          </FormField>
          <FormField label="Repeat">
            <Select options={REPEATS} value={repeat} onChange={setRepeat} placeholder="Repeat" />
          </FormField>
        </div>

        {clashes.length > 0 && (
          <AlertPanel tone="warning" className="!py-3">
            <p className="text-sm text-amber-300">
              Overlaps with{' '}
              {clashes
                .map((c) => `${c.workspaceName} (${dayLabel(new Date(c.startsAt))}, ${timeRange(new Date(c.startsAt), c.durationMinutes)})`)
                .join(', ')}
              . You can still book it; runs will just wait their turn in the queue.
            </p>
          </AlertPanel>
        )}

        <FormField label="Clients">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-ink)]">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand,#8b5cf6)]" checked={allClients} onChange={(e) => setAllClients(e.target.checked)} />
            All active clients ({clients.length})
          </label>
          {!allClients && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
              {clients.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--color-ink)] hover:bg-overlay/[0.04]">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand,#8b5cf6)]" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
            Each client runs its last keyword list again. To use a new list, upload it in New Run before the slot (don't start it) and the slot will use it.
          </p>
        </FormField>

        <FormField label="Note (optional)" error={error}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. mid-month SEO batch" />
        </FormField>
      </div>
    </Modal>
  );
}
