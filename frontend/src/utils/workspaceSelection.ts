// Persists the header's "active workspace" selection per-USER (workspace
// choice isn't nested under anything else the way client choice is nested
// under workspace -- see clientSelection.ts). See SessionContext.tsx for how
// this is wired in.
//
// Deliberately different restore rule than clientSelection.ts's
// resolveActiveClientId: "no client selected" is a supported empty state,
// but every page in this app assumes SOME workspace is active, so an
// invalid/missing/foreign stored workspace id falls back to the first
// workspace the user actually belongs to, rather than resolving to nothing.
// What's preserved from the client-selection fix is the core safety
// property: a workspace the user does NOT currently belong to is NEVER
// silently restored -- it's simply treated the same as "nothing stored" and
// replaced with workspaces[0], never left pointing at an inaccessible
// workspace.

const STORAGE_PREFIX = "serp-console:active-workspace:";

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
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

/** Reads the persisted active-workspace id for a user. Never throws -- returns null if unset or storage is unavailable. */
export function readStoredWorkspaceId(userId: string, storage: KeyValueStorage | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(storageKey(userId)) ?? null;
  } catch {
    return null;
  }
}

/** Persists the active-workspace id for a user. Never throws. */
export function writeStoredWorkspaceId(userId: string, workspaceId: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(storageKey(userId), workspaceId);
  } catch {
    // Selection just won't survive a refresh -- not worth surfacing to the user.
  }
}

/** Clears the persisted active-workspace id for a user. Never throws. */
export function clearStoredWorkspaceId(userId: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(storageKey(userId));
  } catch {
    // ignore
  }
}

/**
 * Pure resolution, no I/O: a stored workspace id is restored only if the
 * user still actually belongs to it (i.e. it's present in `workspaces`,
 * which is always exactly the caller's own memberships -- see GET
 * /api/auth/me). Anything else -- missing, stale, or a workspace the user
 * no longer belongs to -- falls back to the first available workspace,
 * never to a workspace outside `workspaces`. Returns null only when there
 * are no workspaces at all.
 */
export function resolveActiveWorkspaceId(storedId: string | null, workspaces: { id: string }[]): string | null {
  if (storedId && workspaces.some((w) => w.id === storedId)) return storedId;
  return workspaces[0]?.id ?? null;
}
