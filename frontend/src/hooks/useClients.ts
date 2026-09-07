import { useCallback, useEffect, useState } from 'react';
import { getClients } from '../api/client';
import type { ClientRecord } from '../api/types';

/** Refetches whenever workspaceId changes -- null (no active workspace yet) just yields an empty list without calling the API. Exposes `refetch` so callers (e.g. Client Management) can refresh this list after a mutation without a page reload. */
export function useClients(workspaceId: string | null) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchClients = useCallback(() => {
    if (!workspaceId) {
      setClients([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    return getClients(workspaceId)
      .then((data) => {
        setClients(data);
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
      setLoading(false);
      return;
    }
    setLoading(true);
    getClients(workspaceId)
      .then((data) => {
        if (!cancelled) setClients(data);
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

  return { clients, loading, error, refetch: fetchClients };
}
