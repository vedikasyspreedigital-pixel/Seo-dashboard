import { useEffect, useState } from 'react';
import { getClients } from '../api/client';
import type { ClientRecord } from '../api/types';

export function useClients() {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getClients()
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
  }, []);

  return { clients, loading, error };
}
