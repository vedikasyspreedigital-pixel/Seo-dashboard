// One-time, human-run-only login script. This is the ONLY place in the
// spike that ever shows a login form -- it is never automated. You type
// your own ClickUp credentials into ClickUp's own page, in a real browser
// window, exactly as if you'd opened Chrome yourself. Nothing here reads,
// stores, or transmits a password: once you're logged in, we only persist
// the resulting session cookies/tokens (Playwright's `storageState`) so
// later runs can reuse that session without ever seeing the login form.
//
// Run with: npm run setup-session

import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');

async function main() {
  await mkdir(path.dirname(SESSION_PATH), { recursive: true });

  console.log('Launching a real, visible browser window...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.clickup.com/login');

  console.log('\n============================================================');
  console.log('A ClickUp login page should now be open in the browser window.');
  console.log('Please log in manually (including any 2FA/SSO step).');
  console.log('This script does NOT see or touch your password -- you are');
  console.log('typing it directly into ClickUp\'s own page.');
  console.log('============================================================\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Once you can see your ClickUp workspace, press Enter here to continue... ');
  rl.close();

  // Sanity check: if we're still on a login/auth-looking URL, the human
  // probably hit Enter too early. Warn, but still save -- better to let
  // them re-run than silently produce a useless session file.
  const currentUrl = page.url();
  if (/login|auth/i.test(currentUrl)) {
    console.warn(`\nWARNING: current URL still looks like a login page (${currentUrl}).`);
    console.warn('If the saved session doesn\'t work, re-run this script and make sure');
    console.warn('you\'re fully inside your ClickUp workspace before pressing Enter.\n');
  }

  await context.storageState({ path: SESSION_PATH });
  console.log(`Session saved to: ${SESSION_PATH}`);
  console.log('You can now run: npm test');

  await browser.close();
}

main().catch((err) => {
  console.error('setupSession failed:', err);
  process.exit(1);
});
