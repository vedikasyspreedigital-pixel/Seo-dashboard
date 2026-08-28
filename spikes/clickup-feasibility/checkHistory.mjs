// Pure read-only check: opens the task and reports whether the given
// subject text appears anywhere on the page (i.e. in the activity feed).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');
const TASK_URL = process.env.CLICKUP_TASK_URL;
const SUBJECT_SNIPPET = process.env.SUBJECT_SNIPPET ?? 'Your ranking update';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: SESSION_PATH });
const page = await context.newPage();
await page.goto(TASK_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const text = await page.locator('body').innerText();
const idx = text.indexOf(SUBJECT_SNIPPET);
if (idx >= 0) {
  console.log('FOUND:');
  console.log(text.slice(Math.max(0, idx - 150), idx + 250));
} else {
  console.log('NOT FOUND in page text.');
}
await browser.close();
