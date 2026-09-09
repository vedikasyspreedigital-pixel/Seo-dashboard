import { useCallback, useEffect, useState } from 'react';
import { getClients } from '../api/client';
import type { ClientRecord } from '../api/types';

/**
 * Refetches whenever workspaceId changes -- null (no active workspace yet)
 * just yields an empty list without calling the API. Exposes `refetch` so
 * callers (e.g. Client Management) can refresh this list after a mutation
 * without a page reload.
 *
 * Also exposes `forWorkspaceId`: which workspace the CURRENT `clients` array
 * actually belongs to, updated in the same state write as `clients` itself
 * (never via a separate effect). A consumer that needs to know "has this
 * workspace's list actually loaded yet" should compare `forWorkspaceId` to
 * the workspace it cares about, rather than trusting `loading` alone --
 * `loading` flips to true asynchronously (inside this hook's own effect),
 * so a sibling effect in the same component can otherwise observe a stale
 * `loading: false` / `clients: []` pair for one commit right after
 * workspaceId changes, before this hook's effect has actually run.
 */
export function useClients(workspaceId: string | null) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [forWorkspaceId, setForWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchClients = useCallback(() => {
    if (!workspaceId) {
      setClients([]);
      setForWorkspaceId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    return getClients(workspaceId)
      .then((data) => {
        setClients(data);
        setForWorkspaceId(workspaceId);
      })
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setClients([]);
      setForWorkspaceId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    getClients(workspaceId)
      .then((data) => {
        if (!cancelled) {
          setClients(data);
          setForWorkspaceId(workspaceId);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return { clients, loading, error, forWorkspaceId, refetch: fetchClients };
}
