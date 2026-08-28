import { useEffect, useRef, useState } from 'react';
import { getRunProgress } from '../api/client';
import type { RunProgress } from '../api/types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);

/**
 * Simple polling hook -- plain setTimeout, no React Query. A single
 * consumer polling one endpoint doesn't need query caching/dedup, so the
 * extra dependency wasn't justified here.
 */
export function useRunProgress(runId: string | null, intervalMs = 1500) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runId) {
      setProgress(null);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const data = await getRunProgress(runId as string);
        if (cancelled) return;
        setProgress(data);
        if (!TERMINAL_STATUSES.has(data.runStatus)) {
          timerRef.current = window.setTimeout(poll, intervalMs);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [runId, intervalMs]);

  return { progress, error };
}
