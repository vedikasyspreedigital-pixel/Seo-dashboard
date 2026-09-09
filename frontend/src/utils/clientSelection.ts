// Persists the header's "active client" selection per-workspace, and
// validates it before ever restoring it. See ClientContext.tsx for how this
// is wired in -- the important invariant lives here, in one pure function:
// a stored id is restored ONLY if it's still present in that workspace's
// current (active, non-archived) client list. Deleted, deactivated,
// archived, or foreign-workspace ids all simply fail to appear in that
// list, so they're all handled the same way: cleared, never substituted
// with clients[0] or any other client.

const STORAGE_PREFIX = "serp-console:active-client:";

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}${workspaceId}`;
}

/** Minimal localStorage-shaped interface so this is testable without a DOM. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the persisted active-client id for a workspace. Never throws -- returns null if unset or storage is unavailable (private browsing, disabled storage, etc). */
export function readStoredClientId(workspaceId: string, storage: KeyValueStorage | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(storageKey(workspaceId)) ?? null;
  } catch {
    return null;
  }
}

/** Persists the active-client id for a workspace. Never throws. */
export function writeStoredClientId(workspaceId: string, clientId: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(storageKey(workspaceId), clientId);
  } catch {
    // Selection just won't survive a refresh -- not worth surfacing to the user.
  }
}

/** Clears the persisted active-client id for a workspace. Never throws. */
export function clearStoredClientId(workspaceId: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(storageKey(workspaceId));
  } catch {
    // ignore
  }
}

/**
 * Pure validation, no I/O: a stored client id is only ever restored if it's
 * actually present in the given client list (already scoped to the current
 * workspace, already filtered to active/non-archived by the API) -- this
 * NEVER falls back to clients[0] or any other substitute. Returns null for
 * a missing storedId, or one that's deleted/inactive/archived/belongs to a
 * different workspace -- all of those simply show up as "not in this list."
 */
export function resolveActiveClientId(storedId: string | null, clients: { id: string }[]): string | null {
  if (!storedId) return null;
  return clients.some((c) => c.id === storedId) ? storedId : null;
}
