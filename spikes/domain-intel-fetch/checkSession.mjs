// Read-only check: does a saved Flikover login still work in a fresh browser?
// Opens ONE page (Ahrefs Site Explorer) with the saved session, reports what it
// sees, and closes. Never types, never logs in or out, never exports.
//   node spikes/domain-intel-fetch/checkSession.mjs [headed]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session', 'flikover-storage-state.json');
const browser = await chromium.launch({ headless: process.argv[2] !== 'headed' });
try {
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();
  await page.goto('https://ahn.flikover.com/site-explorer', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const search = page.getByPlaceholder('Domain or URL');
  const ok = await search.first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
  const url = new URL(page.url());
  const challenge = /challenges\.cloudflare|__cf_chl/.test(page.url()) || (await page.locator('iframe[src*="challenges.cloudflare.com"]').count()) > 0;
  console.log(JSON.stringify({ landedOn: url.origin + url.pathname, siteExplorerReady: ok, cloudflareChallenge: challenge, title: await page.title() }));
} finally {
  await browser.close();
}
