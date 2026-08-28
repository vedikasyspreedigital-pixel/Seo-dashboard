// Isolated ClickUp automation feasibility spike.
//
// Proves (or disproves) 5 things against ONE dedicated test ClickUp task:
//   1. Open the task with a persisted, authenticated session.
//   2. Click Comment -> Email.
//   3. Fill To / Subject / Body.
//   4. Attach a test file.
//   5. Click Send and VERIFY the email actually appears in the task's
//      history -- clicking Send is never treated as success on its own.
//
// This script does NOT import, call, or know about anything in backend/ or
// frontend/. It is not wired into approveAndSend.ts, the reporting
// pipeline, Claude, or DataForSEO. It exists only to answer: can this be
// automated reliably at all, and what does ClickUp's real DOM look like.
//
// Usage:
//   CLICKUP_TASK_URL=https://app.clickup.com/t/xxxxxxx \
//   TEST_RECIPIENT_EMAIL=you@your-own-domain.com \
//   npm test
//
// By default this is a DRY RUN: it does everything up to and including
// attaching the file, then stops WITHOUT clicking Send, so you can watch
// the headed browser and confirm the composer looks right first. Add
// CONFIRM_SEND=true only once you've verified that.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const TEST_FILE_PATH = path.join(__dirname, 'fixtures', 'test-report.html');

const TASK_URL = process.env.CLICKUP_TASK_URL;
const TEST_RECIPIENT = process.env.TEST_RECIPIENT_EMAIL;
const TEST_SUBJECT = process.env.TEST_SUBJECT ?? `ClickUp automation spike ${new Date().toISOString()}`;
const TEST_BODY = process.env.TEST_BODY ?? 'This is a test email sent by the ClickUp automation feasibility spike. Safe to ignore/delete.';
const CONFIRM_SEND = process.env.CONFIRM_SEND === 'true';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const steps = [];

function logStep(name, status, details = '') {
  const entry = { name, status, details, at: new Date().toISOString() };
  steps.push(entry);
  const marker = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP', INFO: 'INFO' }[status] ?? status;
  console.log(`[${marker}] ${name}${details ? ` -- ${details}` : ''}`);
}

async function screenshot(page, name) {
  try {
    const file = path.join(RESULTS_DIR, `${runId}__${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (err) {
    console.warn(`  (screenshot "${name}" failed: ${err.message})`);
    return null;
  }
}

/**
 * Introspects every input/textarea/contenteditable/button inside a
 * container and returns a structured inventory -- this is the "discovered
 * selectors" deliverable, produced by reading the LIVE DOM rather than
 * guessing ClickUp's markup in advance.
 */
async function inventoryFields(page, containerSelector) {
  return page.evaluate((sel) => {
    const container = document.querySelector(sel) ?? document.body;
    const candidates = container.querySelectorAll(
      'input, textarea, [contenteditable="true"], button, [role="button"], [role="textbox"], [role="menuitem"]',
    );
    return Array.from(candidates).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      dataTestId: el.getAttribute('data-testid') ?? el.getAttribute('data-test'),
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
      text: (el.textContent || '').trim().slice(0, 60),
    }));
  }, containerSelector);
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  if (!TASK_URL) {
    logStep('config', 'FAIL', 'CLICKUP_TASK_URL is not set. Point this at ONE dedicated test task, never a real client task.');
    return finish();
  }
  if (!TEST_RECIPIENT) {
    logStep('config', 'FAIL', 'TEST_RECIPIENT_EMAIL is not set. Use an address you own/monitor, never a real client address.');
    return finish();
  }

  try {
    await import('node:fs/promises').then((fs) => fs.access(SESSION_PATH));
  } catch {
    logStep('session', 'FAIL', `No session file at ${SESSION_PATH}. Run "npm run setup-session" first.`);
    return finish();
  }
  logStep('config', 'INFO', `task=${TASK_URL} recipient=${TEST_RECIPIENT} dryRun=${!CONFIRM_SEND}`);

  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  try {
    // Step 1: open the task with the persisted session. ClickUp is a heavy
    // SPA -- the URL resolving and the task panel actually rendering are
    // two different things, so this polls for real task-view content
    // (rather than a fixed sleep) before moving on.
    await page.goto(TASK_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const urlAfterLoad = page.url();
    if (/login|auth/i.test(urlAfterLoad)) {
      logStep('open-task', 'FAIL', `Redirected to a login-looking URL (${urlAfterLoad}) -- session is likely expired. Re-run "npm run setup-session".`);
      await screenshot(page, '01-session-expired');
      return finish(browser);
    }

    const taskViewLoaded = await page
      .getByText(/^(Status|Assignees|Priority)$/i)
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!taskViewLoaded) {
      logStep(
        'open-task',
        'FAIL',
        `Loaded ${page.url()} but the task panel never rendered recognizable content (Status/Assignees/Priority) within 20s.`,
      );
      await screenshot(page, '01-task-panel-not-found');
      return finish(browser);
    }
    logStep('open-task', 'PASS', `Loaded ${page.url()}`);
    await screenshot(page, '01-task-open');

    // Step 2/3: get into Email mode. ClickUp's mode selector is sticky per
    // user/workspace -- it may already be showing "Email" (with To/Subject
    // fields already visible) rather than "Comment", so this checks for an
    // already-present "To" field FIRST and only drives the Comment -> Email
    // dropdown if that field isn't there yet.
    const alreadyInEmailMode = await page
      .getByPlaceholder(/^\s*to\s*$/i)
      .first()
      .isVisible()
      .catch(() => false);

    if (alreadyInEmailMode) {
      logStep('find-comment-dropdown', 'SKIP', 'Composer is already in Email mode (To field visible) -- no mode switch needed.');
      logStep('select-email-mode', 'SKIP', 'Already in Email mode.');
    } else {
      // Multiple candidate strategies, tried in order -- ClickUp's exact
      // markup is unknown ahead of time, so this is deliberately resilient
      // rather than a single hardcoded selector.
      const commentDropdownCandidates = [
        () => page.getByRole('button', { name: /^\s*comment\s*$/i }),
        () => page.getByText(/^\s*comment\s*$/i).first(),
        () => page.locator('[aria-label*="comment" i]').first(),
      ];
      let commentDropdown = null;
      for (const candidate of commentDropdownCandidates) {
        const locator = candidate();
        if (await locator.count().catch(() => 0)) {
          commentDropdown = locator;
          break;
        }
      }
      if (!commentDropdown) {
        logStep('find-comment-dropdown', 'FAIL', 'No element matching "Comment" found, and not already in Email mode. ClickUp UI may differ from what this spike assumed.');
        await screenshot(page, '02-no-comment-dropdown');
        return finish(browser);
      }
      logStep('find-comment-dropdown', 'PASS');
      await commentDropdown.click();
      await page.waitForTimeout(500);
      await screenshot(page, '02-comment-dropdown-open');

      // Select "Email" from the resulting menu.
      const emailOptionCandidates = [
        () => page.getByRole('menuitem', { name: /^\s*email\s*$/i }),
        () => page.getByRole('option', { name: /^\s*email\s*$/i }),
        () => page.getByText(/^\s*email\s*$/i).first(),
      ];
      let emailOption = null;
      for (const candidate of emailOptionCandidates) {
        const locator = candidate();
        if (await locator.count().catch(() => 0)) {
          emailOption = locator;
          break;
        }
      }
      if (!emailOption) {
        // Diagnostics: if "Email" is visibly on screen but no locator found
        // it, the most likely cause is that it's rendered inside an iframe
        // (page.locator only searches the main frame by default) or a
        // closed shadow root. Dump frame info + a raw text/element
        // inventory so we can see what's actually there instead of
        // guessing blindly through more screenshot round-trips.
        const frameInfo = page.frames().map((f) => ({ url: f.url(), name: f.name() }));
        const bodyInventory = await inventoryFields(page, 'body');
        const emailTextMatches = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const hits = [];
          let node;
          while ((node = walker.nextNode())) {
            if (/^\s*email\s*$/i.test(node.nodeValue)) {
              const el = node.parentElement;
              hits.push({
                text: node.nodeValue,
                tag: el?.tagName.toLowerCase(),
                classes: el?.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
                visible: !!(el && el.getClientRects().length > 0),
              });
            }
          }
          return hits;
        });
        const diagnosticsPath = path.join(RESULTS_DIR, `${runId}__no-email-diagnostics.json`);
        await writeFile(diagnosticsPath, JSON.stringify({ frameInfo, emailTextMatches, bodyInventory }, null, 2));
        logStep(
          'select-email-mode',
          'FAIL',
          `"Email" option not found via locator. frames=${frameInfo.length} (${frameInfo.map((f) => f.url).join(', ')}), raw "Email" text nodes found=${emailTextMatches.length}. Full diagnostics: ${diagnosticsPath}`,
        );
        await screenshot(page, '03-no-email-option');
        return finish(browser);
      }
      await emailOption.click();
      await page.waitForTimeout(1000);
      logStep('select-email-mode', 'PASS');
    }
    await screenshot(page, '03-email-composer-open');

    // Step 4/discovery: inventory every field in the composer area so we
    // have a real record of ClickUp's actual DOM, whether or not the
    // fill/send steps below succeed.
    const fieldInventory = await inventoryFields(page, 'body');
    const fieldInventoryPath = path.join(RESULTS_DIR, `${runId}__field-inventory.json`);
    await writeFile(fieldInventoryPath, JSON.stringify(fieldInventory, null, 2));
    logStep('inventory-composer-fields', 'INFO', `${fieldInventory.length} candidate elements found -- full dump: ${fieldInventoryPath}`);

    // Everything below uses selectors CONFIRMED live against the real
    // composer DOM via diagnoseEmailComposer.mjs / quickAttrCheck.mjs on
    // 2026-08-27 (see spikes/clickup-feasibility/results/*composer-diagnosis.json).
    // Two critical corrections from earlier iterations:
    //   1. ClickUp's real attribute is `data-test`, NOT `data-testid` --
    //      every prior "never attached" failure was querying the wrong
    //      attribute name, not a race condition.
    //   2. "To" is already a real, auto-focused <input> at the moment
    //      Email mode opens -- no toggle click needed at all. The earlier
    //      "click the To toggle" logic is what opened an unrelated Share
    //      dialog; it's removed entirely now.
    const composerRoot = await getComposerRoot(page);
    if (!composerRoot) {
      logStep('find-composer-root', 'FAIL', 'Could not find both email-communicators__subject and comment-bar__send-btn (data-test attribute) with a shared ancestor. Refusing to fall back to page-wide selectors.');
      await screenshot(page, '04-no-composer-root');
      return finish(browser);
    }
    logStep('find-composer-root', 'PASS');

    // Step 5: fill To. Confirmed real, auto-focused input -- no toggle click.
    const toFilled = await fillFirstMatch([() => page.locator('.cu-email-communicators__field-row--to input.cu-search__input')], TEST_RECIPIENT, page);
    logStep('fill-to', toFilled ? 'PASS' : 'FAIL', toFilled ? undefined : 'Could not find/fill the "To" input (.cu-email-communicators__field-row--to input.cu-search__input).');
    if (!toFilled) {
      await screenshot(page, '04-fill-to-failed');
      return finish(browser);
    }
    await screenshot(page, '04-to-filled');

    // Step 6: fill Subject. Confirmed attribute: data-test (not data-testid).
    const subjectFilled = await fillFirstMatch([() => page.locator('[data-test="email-communicators__subject"]')], TEST_SUBJECT, page);
    logStep('fill-subject', subjectFilled ? 'PASS' : 'FAIL', subjectFilled ? undefined : 'Could not find/fill the Subject field (data-test="email-communicators__subject").');

    // Step 7: fill Body. Confirmed: no data-test attribute on the editor
    // itself -- it's a Quill rich-text contenteditable (.ql-editor), and
    // the SAME class is reused for the task description elsewhere on the
    // page, so this is scoped inside composerRoot to avoid ambiguity.
    const bodyFilled = await fillFirstMatch([() => composerRoot.locator('.ql-editor[contenteditable="true"]')], TEST_BODY, page);
    logStep('fill-body', bodyFilled ? 'PASS' : 'FAIL', bodyFilled ? undefined : 'Could not find/fill the body field (.ql-editor[contenteditable="true"] inside composerRoot).');
    await screenshot(page, '05-subject-body-filled');

    // Step 8: attach the test files (HTML fixture + a freshly-generated
    // test PDF, mirroring production's "HTML report + Excel-as-PDF" dual
    // attachment) via the composer's OWN attachment dropdown
    // (data-test="comment-bar__attachment-dropdown-toggle" -- confirmed
    // distinct from data-test="task-view-section-header__add-button-attachments",
    // the unrelated GLOBAL task-attachment button that previously caused
    // ClickUp to silently create a brand new task from the attached file).
    const testPdfPath = path.join(RESULTS_DIR, `${runId}__test-attachment.pdf`);
    const pdfPage = await context.newPage();
    await pdfPage.setContent('<h1>Test PDF attachment</h1><p>Generated by the feasibility spike.</p>');
    await pdfPage.pdf({ path: testPdfPath, format: 'A4' });
    await pdfPage.close();
    const attachmentPaths = [TEST_FILE_PATH, testPdfPath];

    // Confirmed live: the composer's file input does NOT support selecting
    // multiple files in one native chooser (setFiles([a, b]) reliably times
    // out waiting for the chooser event) -- so files are attached one at a
    // time, reopening the SAME attach dropdown for each (never a page-wide
    // input[type=file] search).
    const attachToggle = page.locator('[data-test="comment-bar__attachment-dropdown-toggle"]');
    let attached = false;
    if (await attachToggle.count().catch(() => 0)) {
      attached = true;
      for (const singlePath of attachmentPaths) {
        const attachedOne = await attachOneFile(page, attachToggle, singlePath);
        if (!attachedOne) {
          attached = false;
          break;
        }
        await page.waitForTimeout(500);
      }
    }
    logStep('attach-file', attached ? 'PASS' : 'FAIL', attached ? undefined : 'Could not attach via the composer\'s own attachment dropdown.');
    if (attached) {
      // Wait for an upload-complete signal: the file's name appearing in
      // the composer, with a timeout -- never assume completion instantly.
      const uploadConfirmed = await page
        .getByText('test-report.html', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      logStep('attachment-upload-complete', uploadConfirmed ? 'PASS' : 'WARN', uploadConfirmed ? undefined : 'Filename not confirmed visible within 15s -- upload may still be in progress or may have failed silently.');
    }
    await screenshot(page, '06-attachment-state');

    // Step 9: Send -- gated behind CONFIRM_SEND. Default is a dry run.
    if (!CONFIRM_SEND) {
      logStep('send', 'SKIP', 'Dry run (CONFIRM_SEND not set to "true"). Composer is filled and ready -- review the browser window, then re-run with CONFIRM_SEND=true to actually send.');
      return finish(browser);
    }

    // Confirmed attribute: data-test="comment-bar__send-btn". Confirmed
    // live that it renders `disabled=""` until required fields are filled
    // -- wait for it to actually become enabled, not just present.
    const sendButton = page.locator('[data-test="comment-bar__send-btn"]');
    if (!(await sendButton.count().catch(() => 0))) {
      logStep('send', 'FAIL', 'No "Send" button found (data-test="comment-bar__send-btn").');
      await screenshot(page, '07-no-send-button');
      return finish(browser);
    }
    const sendEnabled = await sendButton
      .first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .then(() => sendButton.first().isEnabled())
      .catch(() => false);
    if (!sendEnabled) {
      logStep('send', 'FAIL', 'Send button is present but disabled -- a required field (To/Subject) is likely still empty or invalid.');
      await screenshot(page, '07-send-disabled');
      return finish(browser);
    }

    await sendButton.click();
    logStep('send-clicked', 'INFO', 'Send was clicked. This is NOT treated as success -- verifying in task history next.');
    await page.waitForTimeout(3000);
    await screenshot(page, '07-after-send-click');

    // Step 10: verification. Clicking Send is never sufficient on its own
    // -- look for the sent email actually showing up in the task's
    // activity/history with a matching subject.
    const verified = await page
      .getByText(TEST_SUBJECT, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    if (verified) {
      logStep('verify-in-history', 'PASS', 'Found an entry matching the test subject in the task activity/history.');
    } else {
      logStep('verify-in-history', 'FAIL', 'Could not confirm the email in task history within 20s. DO NOT treat this send as confirmed successful.');
    }
    await screenshot(page, '08-verification-state');
  } catch (err) {
    logStep('unexpected-error', 'FAIL', err instanceof Error ? err.message : String(err));
    await screenshot(page, '99-unexpected-error');
  }

  return finish(browser);
}

/**
 * Establishes a scoped locator for the email composer container, anchored
 * on two CONFIRMED-live selectors -- [data-test="email-communicators__subject"]
 * and [data-test="comment-bar__send-btn"] (ClickUp uses the attribute
 * `data-test`, NOT `data-testid` -- confirmed via diagnoseEmailComposer.mjs
 * / quickAttrCheck.mjs on 2026-08-27; every earlier "never attached"
 * failure was querying the wrong attribute name, not a real timing issue:
 * a live diagnostic showed the composer's editable-element count settles
 * within 500ms and stays stable for a full 10s afterward) -- by walking up
 * from the Subject input until it contains the Send button too. This lets
 * Body (an ambiguous .ql-editor class, reused for the task description
 * elsewhere on the page) be scoped safely without ever falling back to a
 * page-wide search.
 */
async function getComposerRoot(page, timeoutMs = 8000) {
  const marker = 'data-feasibility-composer-root';

  const subject = page.locator('[data-test="email-communicators__subject"]').first();
  if (!(await subject.waitFor({ state: 'attached', timeout: timeoutMs }).then(() => true).catch(() => false))) return null;

  const send = page.locator('[data-test="comment-bar__send-btn"]').first();
  if (!(await send.waitFor({ state: 'attached', timeout: timeoutMs }).then(() => true).catch(() => false))) return null;

  const found = await page.evaluate((marker) => {
    const subjectEl = document.querySelector('[data-test="email-communicators__subject"]');
    const sendEl = document.querySelector('[data-test="comment-bar__send-btn"]');
    if (!subjectEl || !sendEl) return false;
    let node = subjectEl.parentElement;
    while (node && !node.contains(sendEl)) node = node.parentElement;
    if (!node) return false;
    node.setAttribute(marker, 'true');
    return true;
  }, marker);
  if (!found) return null;
  return page.locator(`[${marker}]`).first();
}

async function attachOneFile(page, attachToggle, filePath) {
  try {
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), attachToggle.click()]);
    await fileChooser.setFiles(filePath);
    return true;
  } catch {
    // No native file chooser fired directly -- a menu (Upload from
    // computer / Google Drive / ...) may have opened instead. Look for an
    // "upload" option inside the newly-opened overlay only.
    await page.waitForTimeout(400);
    const uploadOption = page.locator('.cdk-overlay-container').getByText(/upload|computer|device/i).first();
    if (!(await uploadOption.count().catch(() => 0))) return false;
    try {
      const [fileChooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), uploadOption.click()]);
      await fileChooser.setFiles(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

async function fillFirstMatch(candidates, value, page) {
  for (const candidate of candidates) {
    const locator = candidate();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: 3000 });
        await page.keyboard.type(value, { delay: 20 });
        await page.keyboard.press('Enter').catch(() => {});
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

async function finish(browser) {
  const summary = {
    runId,
    taskUrl: TASK_URL,
    recipient: TEST_RECIPIENT,
    dryRun: !CONFIRM_SEND,
    steps,
  };
  const reportPath = path.join(RESULTS_DIR, `${runId}__report.json`);
  await writeFile(reportPath, JSON.stringify(summary, null, 2));

  console.log('\n============================================================');
  console.log('FEASIBILITY SPIKE SUMMARY');
  console.log('============================================================');
  for (const s of steps) {
    console.log(`  [${s.status}] ${s.name}${s.details ? ` -- ${s.details}` : ''}`);
  }
  console.log(`\nFull report + screenshots: ${RESULTS_DIR}`);
  console.log(`JSON report: ${reportPath}`);

  if (browser) {
    console.log('\nBrowser window left open for 15s so you can inspect it -- closing after that.');
    await new Promise((resolve) => setTimeout(resolve, 15000));
    await browser.close();
  }
}

main().catch((err) => {
  console.error('feasibilityTest crashed:', err);
  process.exit(1);
});
