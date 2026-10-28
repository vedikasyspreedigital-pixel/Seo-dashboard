import type { DomainBundleReport } from '../api/client';

/**
 * Why the ticked Domain Intelligence reports can't run (null = they can). Same rule as the server
 * (backend/domainIntel/bundleJob.ts startBundle): the AI SEO Audit is written from the Site Audit and
 * the WooRank audit, so it needs both (the user's choice, 2026-10-27).
 */
export function bundleSelectionProblem(selected: DomainBundleReport[]): string | null {
  if (selected.length === 0) return 'Tick at least one report.';
  if (selected.includes('aiaudit') && !(selected.includes('siteaudit') && selected.includes('woorank')))
    return 'The AI SEO Audit is written from the Site Audit and the WooRank audit — tick both of them too.';
  return null;
}
