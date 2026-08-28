// One-off, read-only: confirms the exact attribute name (data-test vs
// data-testid) ClickUp actually uses for the composer's body/send/attach
// controls. No filling, no clicking, no Send.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');
const TASK_URL = process.env.CLICKUP_TASK_URL;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: SESSION_PATH });
const page = await context.newPage();
await page.goto(TASK_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.getByText(/^(Status|Assignees|Priority)$/i).first().waitFor({ state: 'visible', timeout: 20000 });
const alreadyInEmailMode = await page.getByPlaceholder(/^\s*to\s*$/i).first().isVisible().catch(() => false);
if (!alreadyInEmailMode) {
  await page.getByText(/^\s*comment\s*$/i).first().click();
  await page.waitForTimeout(500);
  await page.getByText(/^\s*email\s*$/i).first().click();
}
await page.waitForTimeout(1500);

const result = await page.evaluate(() => {
  const findByAttr = (selectorFragment) => {
    const byDataTest = document.querySelector(`[data-test="${selectorFragment}"]`);
    const byDataTestId = document.querySelector(`[data-testid="${selectorFragment}"]`);
    return {
      matchesDataTest: !!byDataTest,
      matchesDataTestId: !!byDataTestId,
    };
  };

  // Also directly inspect the quill editor and any button whose visible
  // text/aria suggests Send, and any button whose aria suggests Attach.
  const editor = document.querySelector('.ql-editor[contenteditable="true"]');
  const editorAttrs = editor ? Array.from(editor.attributes).map((a) => `${a.name}="${a.value}"`) : null;

  const buttons = Array.from(document.querySelectorAll('button'));
  const sendCandidates = buttons
    .filter((b) => /send/i.test(b.className) || /send/i.test(b.getAttribute('aria-label') || '') || /send/i.test(b.getAttribute('data-test') || '') || /send/i.test(b.getAttribute('data-testid') || ''))
    .map((b) => ({
      outerHTML: b.outerHTML.slice(0, 500),
      attrs: Array.from(b.attributes).map((a) => `${a.name}="${a.value}"`),
    }));

  const attachCandidates = buttons
    .filter((b) => /attach/i.test(b.className) || /attach/i.test(b.getAttribute('aria-label') || '') || /attach/i.test(b.getAttribute('data-test') || '') || /attach/i.test(b.getAttribute('data-testid') || ''))
    .map((b) => ({
      outerHTML: b.outerHTML.slice(0, 500),
      attrs: Array.from(b.attributes).map((a) => `${a.name}="${a.value}"`),
    }));

  return {
    subject: findByAttr('email-communicators__subject'),
    editorAttrs,
    sendCandidates,
    attachCandidates,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
