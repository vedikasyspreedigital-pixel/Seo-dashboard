// Pure diagnostics. Read-only investigation of the live ClickUp Email
// composer DOM -- no filling, no attaching, no clicking Send, no
// production code touched. Opens the task, gets into Email mode exactly
// like feasibilityTest.mjs does, then dumps as much raw structural
// information as possible so real selectors can be picked from evidence
// instead of guesses.
//
// Usage:
//   CLICKUP_TASK_URL=https://app.clickup.com/t/xxxxxxx npm run diagnose

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const TASK_URL = process.env.CLICKUP_TASK_URL;

const runId = new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  if (!TASK_URL) throw new Error('CLICKUP_TASK_URL is not set.');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  await page.goto(TASK_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  if (/login|auth/i.test(page.url())) throw new Error(`Session expired -- redirected to ${page.url()}`);

  await page
    .getByText(/^(Status|Assignees|Priority)$/i)
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });

  // Get into Email mode (already-in-email-mode check first, same as the main script).
  const alreadyInEmailMode = await page.getByPlaceholder(/^\s*to\s*$/i).first().isVisible().catch(() => false);
  if (!alreadyInEmailMode) {
    const commentDropdown = page.getByText(/^\s*comment\s*$/i).first();
    await commentDropdown.click();
    await page.waitForTimeout(500);
    const emailOption = page.getByText(/^\s*email\s*$/i).first();
    await emailOption.click();
  }

  // Capture at several points in time -- if the composer is genuinely
  // re-rendering/settling, a series of snapshots will show it; if it's
  // stable, all snapshots will look the same.
  const snapshots = [];
  for (const delayMs of [0, 500, 1500, 3000, 6000, 10000]) {
    if (delayMs > 0) await page.waitForTimeout(delayMs - (snapshots.at(-1)?.atMs ?? 0));
    const snap = await captureSnapshot(page);
    snapshots.push({ atMs: delayMs, ...snap });
    await page.screenshot({ path: path.join(RESULTS_DIR, `${runId}__diag-${String(delayMs).padStart(5, '0')}ms.png`), fullPage: true });
  }

  const iframeCount = page.frames().length - 1; // minus main frame
  const frameUrls = page.frames().map((f) => f.url());

  const report = { runId, taskUrl: TASK_URL, iframeCount, frameUrls, snapshots };
  const reportPath = path.join(RESULTS_DIR, `${runId}__composer-diagnosis.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nDiagnosis written to: ${reportPath}`);
  console.log(`Screenshots: ${RESULTS_DIR}\\${runId}__diag-*.png`);
  console.log(`iframes on page (excluding main frame): ${iframeCount}`);
  for (const snap of snapshots) {
    console.log(`\n--- at +${snap.atMs}ms ---`);
    console.log(`  total input/textarea/contenteditable/role=textbox: ${snap.editableCount}`);
    console.log(`  labeled fields found: ${snap.labeledFields.map((f) => f.label).join(', ') || '(none)'}`);
  }

  await browser.close();
}

/**
 * For each of the field labels we care about, finds text nodes matching
 * that label (whitespace-tolerant) and records: the label element's own
 * outerHTML, its containing row/section outerHTML (truncated), and every
 * editable element (input/textarea/contenteditable/role=textbox) found
 * within 4 ancestor levels of the label, with ITS outerHTML + bounding
 * box + computed visibility. Also separately lists every editable element
 * on the page regardless of a nearby label, so nothing is missed even if
 * a field has no text label at all (e.g. rendered via a chip/avatar UI).
 */
async function captureSnapshot(page) {
  return page.evaluate(() => {
    const LABELS = ['to', 'cc', 'bcc', 'from', 'subject', 'body', 'send', 'attach', 'attachment'];

    function describeEl(el, htmlLen = 400) {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className.slice(0, 150) : null,
        role: el.getAttribute('role'),
        contentEditable: el.getAttribute('contenteditable'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder'),
        dataTestId: el.getAttribute('data-testid') ?? el.getAttribute('data-test'),
        type: el.getAttribute('type'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0,
        outerHTML: (el.outerHTML || '').slice(0, htmlLen),
      };
    }

    function findLabelHits(labelWord) {
      const re = new RegExp(`^\\s*${labelWord}\\s*:?\\s*$`, 'i');
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!re.test(node.nodeValue || '')) continue;
        const labelEl = node.parentElement;
        if (!labelEl) continue;

        // Walk up to 4 ancestor levels collecting any editable descendants
        // that aren't the label itself.
        let container = labelEl;
        const nearbyEditables = [];
        for (let depth = 0; depth < 4 && container; depth++) {
          const editables = container.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]');
          for (const ed of editables) {
            if (ed !== labelEl && !nearbyEditables.includes(ed)) nearbyEditables.push(ed);
          }
          container = container.parentElement;
        }

        hits.push({
          label: describeEl(labelEl, 200),
          containerAtDepth4: describeEl(container, 800),
          nearbyEditables: nearbyEditables.slice(0, 5).map((ed) => describeEl(ed)),
        });
      }
      return hits;
    }

    const labeledFieldsRaw = LABELS.flatMap((word) => findLabelHits(word).map((hit) => ({ label: word, ...hit })));

    const allEditable = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')).map((el) =>
      describeEl(el, 250),
    );

    const shadowHosts = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.shadowRoot)
      .map((el) => ({ tag: el.tagName.toLowerCase(), classes: typeof el.className === 'string' ? el.className.slice(0, 100) : null }))
      .slice(0, 20);

    return {
      editableCount: allEditable.length,
      labeledFields: labeledFieldsRaw,
      allEditable,
      shadowHostsFound: shadowHosts.length,
      shadowHostsSample: shadowHosts,
    };
  });
}

main().catch((err) => {
  console.error('diagnoseEmailComposer crashed:', err);
  process.exit(1);
});
