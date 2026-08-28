import { Card } from '../ui/Card';
import { UserIcon } from '../ui/icons';
import type { ClientRecord } from '../../api/types';

/** "Account Details" from the reference, adapted honestly: this app has no
 * user-account system (single shared internal access, per the sidebar's
 * "Admin / Internal access"), so this shows the real selected CLIENT's
 * details instead of inventing a fake user profile -- name, id, status,
 * and client-since date are all real Client fields. */
export function ClientDetailsCard({ client, totalRunsForClient }: { client: ClientRecord | null; totalRunsForClient: number | null }) {
  if (!client) {
    return (
      <Card className="p-6">
        <p className="text-[13px] font-semibold text-[var(--color-ink)]">Client Details</p>
        <p className="mt-3 text-sm text-[var(--color-ink-faint)]">Select a client to see their details.</p>
      </Card>
    );
  }

  const clientSince = new Date(client.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
          <UserIcon className="h-5 w-5" />
        </span>
        <span>
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-ink)]">{client.name}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
                client.isActive ? 'bg-brand-400/15 text-brand-300' : 'bg-white/[0.05] text-[var(--color-ink-faint)]'
              }`}
            >
              {client.isActive ? 'Active' : 'Inactive'}
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">Client Details</span>
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Client ID</p>
          <p className="mt-1 truncate font-mono text-[13px] text-[var(--color-ink)]" title={client.id}>
            {client.id.slice(0, 8)}
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Client Since</p>
          <p className="mt-1 text-[13px] text-[var(--color-ink)]">{clientSince}</p>
        </div>
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Total Runs</p>
          <p className="mt-1 text-[13px] text-[var(--color-ink)]">{totalRunsForClient ?? '—'}</p>
        </div>
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-ink-faint)]">Status</p>
          <p className="mt-1 text-[13px] text-[var(--color-ink)]">{client.isActive ? 'Active' : 'Inactive'}</p>
        </div>
      </div>
    </Card>
  );
}
