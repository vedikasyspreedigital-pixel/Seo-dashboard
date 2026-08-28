// Locked request mapping (see architecture discussion): the wildcard
// target is sent verbatim, never normalized. device/os/depth are fixed
// constants matching the original Make.com scenario.

const DEVICE = 'desktop';
const OS = 'windows';
const DEPTH = 100;

/**
 * @param {{ keyword: string, targetUrl: string, locationName: string, seDomain: string, languageName: string }} row
 */
export function buildDataForSeoRequest(row) {
  return {
    keyword: row.keyword,
    target: row.targetUrl,
    location_name: row.locationName,
    se_domain: row.seDomain,
    language_name: row.languageName,
    device: DEVICE,
    os: OS,
    depth: DEPTH,
  };
}
