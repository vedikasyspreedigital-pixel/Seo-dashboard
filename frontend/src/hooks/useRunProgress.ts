import { useCallback, useEffect, useRef, useState } from 'react';
import { getRunProgress } from '../api/client';
import type { RunProgress } from '../api/types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
const ERROR_RETRY_MS = 4000;

/**
 * Simple polling hook -- plain setTimeout, no React Query. A single
 * consumer polling one endpoint doesn't need query caching/dedup, so the
 * extra dependency wasn't justified here.
 */
export function useRunProgress(runId: string | null, intervalMs = 1500) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!runId) {
      setProgress(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const data = await getRunProgress(runId as string);
        if (cancelled) return;
        setProgress(data);
        setError(null);
        if (!TERMINAL_STATUSES.has(data.runStatus)) {
          timerRef.current = window.setTimeout(poll, intervalMs);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        // A transient network error must not permanently freeze `progress`
        // -- previously this just gave up, so a run that finished on the
        // backend while a poll happened to fail would never be observed as
        // terminal client-side. Keep retrying (slower than the happy-path
        // interval) until either a poll succeeds or the effect is torn down.
        timerRef.current = window.setTimeout(poll, ERROR_RETRY_MS);
      }
    }

    pollRef.current = poll;
    poll();

    return () => {
      cancelled = true;
      pollRef.current = null;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [runId, intervalMs]);

  // Manual fallback (e.g. a "Refresh" button) -- cancels any pending timer
  // and polls immediately, same function as the regular loop so it
  // re-schedules itself normally afterward if still non-terminal.
  const refresh = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    pollRef.current?.();
  }, []);

  return { progress, error, refresh };
}
