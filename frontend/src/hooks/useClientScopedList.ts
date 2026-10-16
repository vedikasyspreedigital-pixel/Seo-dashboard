import { useCallback, useEffect, useState } from 'react';

/**
 * Loads a list that belongs to the active client (runs, reports), with an
 * explicit error state. The list pages used to have no error branch at all, so
 * a failed request ended as an empty list -- "No reports yet" -- and looked
 * like lost data (2026-10-16). `reload` retries on demand; `setItems` lets a
 * page update the list after its own actions (e.g. deleting a run).
 */
export function useClientScopedList<T>(clientId: string | null, load: (clientId: string) => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!clientId) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    load(clientId)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((err: Error) => {
        // Keep whatever was already shown -- never replace real data with an empty list.
        if (!cancelled) setError(err.message || 'Something went wrong.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `load` is a stable module-level API function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { items, setItems, loading, error, reload };
}
