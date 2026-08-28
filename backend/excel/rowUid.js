import { createHash } from 'node:crypto';

/**
 * Deterministic identity for a tracked keyword, stable across runs/uploads
 * for the same client -- NOT derived from the Excel row number. This is
 * what lets Phase 2 compare "this keyword's rank" across separate weekly
 * runs even though row order/count in the sheet can change.
 */
export function computeRowUid({ clientId, keyword, targetUrl, locationName, languageName, seDomain }) {
  const parts = [clientId, keyword, targetUrl, locationName, languageName, seDomain].map((value) =>
    (value ?? '').toString().trim().toLowerCase()
  );
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
