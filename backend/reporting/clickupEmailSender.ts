// This is the Email Agent's send-report capability -- NOT a standalone
// "email sending API." Conceptually: SERP Console produces an approved
// email draft, and the Email Agent is the thing that operates the client's
// ClickUp workspace to act on it -- opening the right task, driving
// ClickUp's own Email integration, attaching the generated report, running
// whatever other steps that client's workflow requires, and sending is only
// one part of that. See spikes/clickup-feasibility/feasibilityTest.mjs for
// the original proof-of-concept this is built from.
//
// It's exposed here as a SendEmailFn so the existing reporting pipeline
// (approveAndSendReport) doesn't need to know or care -- that boundary is
// deliberately kept exactly as it was, so plugging the Email Agent in (via
// CLICKUP_EMAIL_LIVE in server.ts) requires zero changes to the pipeline
// itself. This runs headless and is NOT wired into app.ts's default
// injection -- swap it in only after the spike has been run for real
// against a live ClickUp workspace and the selectors below confirmed.
//
// Client-specific behavior (which ClickUp config/task a client maps to,
// what fields need mapping, what other workflow steps a given client's
// process requires) is deliberately NOT modeled yet -- that mapping will be
// provided separately. `performClientWorkflowActions` below is the intended
// extension point for it once it lands; today it's a no-op.
//
// Selector strategy mirrors the spike deliberately: multiple candidate
// locators per field, tried in order, because ClickUp's exact DOM was
// unknown ahead of time and may have shifted since the spike was written.
// If ClickUp changes their markup, this is the file to update -- ideally
// after re-running the spike to see the new DOM.
//
// Session handling: this never logs in. It loads a previously-saved
// Playwright storageState (see spikes/clickup-feasibility/setupSession.mjs)
// and throws a clear, actionable error if that session has expired --
// approveAndSendReport already treats any throw here as SEND_FAILED and
// leaves the report APPROVED for a retry, so an expired session never
// corrupts report state.

import { chromium, type Browser, type Page, type Locator } from "playwright";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SendEmailFn, SendEmailParams, SendEmailResult } from "./emailSender.js";

export interface ClickUpEmailSenderOptions {
  /** Path to the storageState JSON produced by setupSession.mjs. */
  sessionStatePath: string;
  /** Defaults to true (headless) -- this runs as a backend service, not an interactive spike. */
  headless?: boolean;
}

export function createClickUpEmailSender({ sessionStatePath, headless = true }: ClickUpEmailSenderOptions): SendEmailFn {
  return async function sendViaClickUp(params: SendEmailParams): Promise<SendEmailResult> {
    if (!params.clickupTaskUrl) {
      throw new Error(
        "No ClickUp task resolved for this report -- set clickupTaskUrl on the client's ClientReportConfig (or fill in the ClickUp Task field on the draft) before approving.",
      );
    }
    if (params.to.length === 0) {
      throw new Error("No recipients to send to.");
    }

    let browser: Browser | undefined;
    const tempAttachmentPaths: string[] = [];

    try {
      browser = await chromium.launch({ headless });
      const context = await browser.newContext({ storageState: sessionStatePath });
      const page = await context.newPage();

      await page.goto(params.clickupTaskUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
      if (/login|auth/i.test(page.url())) {
        throw new Error(
          `ClickUp session expired (redirected to ${page.url()}). Re-run "npm run setup-session" in spikes/clickup-feasibility to refresh it.`,
        );
      }

      // ClickUp is a heavy SPA -- the URL resolving and the task panel
      // actually rendering are two different things, so this polls for
      // real task-view content rather than trusting a fixed sleep.
      const taskViewLoaded = await page
        .getByText(/^(Status|Assignees|Priority)$/i)
        .first()
        .waitFor({ state: "visible", timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (!taskViewLoaded) {
        throw new Error(`Task panel never rendered recognizable content (Status/Assignees/Priority) within 20s at ${page.url()}.`);
      }

      // The mode selector is sticky per user/workspace -- it may already be
      // showing "Email" (To/Subject fields already visible) rather than
      // "Comment", so check for that first and only drive the Comment ->
      // Email dropdown if it isn't already there.
      const alreadyInEmailMode = await page
        .getByPlaceholder(/^\s*to\s*$/i)
        .first()
        .isVisible()
        .catch(() => false);

      if (!alreadyInEmailMode) {
        const commentDropdown = await firstMatch(page, [
          () => page.getByRole("button", { name: /^\s*comment\s*$/i }),
          () => page.getByText(/^\s*comment\s*$/i).first(),
          () => page.locator('[aria-label*="comment" i]').first(),
        ]);
        if (!commentDropdown) {
          throw new Error('Could not find the "Comment" mode control on the ClickUp task, and not already in Email mode -- page layout may have changed.');
        }
        await commentDropdown.click();
        await page.waitForTimeout(500);

        const emailOption = await firstMatch(page, [
          () => page.getByRole("menuitem", { name: /^\s*email\s*$/i }),
          () => page.getByRole("option", { name: /^\s*email\s*$/i }),
          () => page.getByText(/^\s*email\s*$/i).first(),
        ]);
        if (!emailOption) throw new Error('Could not find "Email" in the Comment mode menu -- Email mode may not be enabled for this task/workspace.');
        await emailOption.click();
        await page.waitForTimeout(1000);
      }

      // Everything below uses selectors CONFIRMED live against ClickUp's
      // real composer DOM via diagnoseEmailComposer.mjs / quickAttrCheck.mjs
      // on 2026-08-27 (see spikes/clickup-feasibility/results/*composer-diagnosis.json)
      // and proven end-to-end in feasibilityTest.mjs. Two corrections from
      // an earlier version of this file:
      //   1. ClickUp's real attribute is `data-test`, NOT `data-testid` --
      //      every earlier "never attached" failure was querying the wrong
      //      attribute name, not a race condition.
      //   2. "To" is already a real, auto-focused <input> the moment Email
      //      mode opens -- no toggle click needed. The old "click the To
      //      toggle" logic is what once opened an unrelated Share dialog on
      //      the live task; it's removed entirely now.
      // Every selector here is either a composer-specific data-test, or
      // explicitly scoped inside the composer root -- never a page-wide
      // search (an even earlier version grabbed the first `input[type=file]`
      // on the whole page for the attach step, which was actually a GLOBAL
      // task-uploader input and caused ClickUp to silently create a brand
      // new task from the attached file).
      const composerRoot = await getComposerRoot(page);
      if (!composerRoot) {
        throw new Error(
          'Could not find both [data-test="email-communicators__subject"] and [data-test="comment-bar__send-btn"] with a shared ancestor -- refusing to fall back to page-wide selectors that could touch unrelated controls.',
        );
      }

      // Confirmed real, auto-focused input -- no toggle click.
      const toFilled = await fillFirstMatch(
        page,
        [() => page.locator('.cu-email-communicators__field-row--to input.cu-search__input')],
        params.to.join(", "),
      );
      if (!toFilled) throw new Error('Could not find/fill the "To" input (.cu-email-communicators__field-row--to input.cu-search__input).');

      // Confirmed attribute: data-test (not data-testid).
      const subjectFilled = await fillFirstMatch(page, [() => page.locator('[data-test="email-communicators__subject"]')], params.subject);
      if (!subjectFilled) throw new Error('Could not find/fill the Subject field (data-test="email-communicators__subject").');

      // Confirmed: no data-test attribute on the editor itself -- it's a
      // Quill rich-text contenteditable (.ql-editor), and the SAME class is
      // reused for the task description elsewhere on the page, so this is
      // scoped inside composerRoot to avoid ambiguity.
      const bodyText = params.bodyHtml ? params.bodyText : params.bodyText;
      const bodyFilled = await fillFirstMatch(page, [() => composerRoot.locator('.ql-editor[contenteditable="true"]')], bodyText);
      if (!bodyFilled) throw new Error('Could not find/fill the body field (.ql-editor[contenteditable="true"] inside composerRoot).');

      if (params.attachmentHtml) {
        const htmlPath = path.join(os.tmpdir(), params.attachmentFilename ?? `report-${Date.now()}.html`);
        await writeFile(htmlPath, params.attachmentHtml, "utf8");
        tempAttachmentPaths.push(htmlPath);
      }
      if (params.excelPdfBuffer) {
        const pdfPath = path.join(os.tmpdir(), params.excelPdfFilename ?? `ranking-export-${Date.now()}.pdf`);
        await writeFile(pdfPath, params.excelPdfBuffer);
        tempAttachmentPaths.push(pdfPath);
      }
      if (tempAttachmentPaths.length > 0) {
        const attached = await attachFile(page, tempAttachmentPaths);
        if (!attached) throw new Error("Could not attach the report/Excel files via the composer's own attachment dropdown.");
      }

      // Extension point for whatever else a given client's ClickUp workflow
      // requires before sending (custom field updates, status changes,
      // additional attachments, etc.) -- intentionally a no-op until the
      // client-to-ClickUp mapping is provided.
      await performClientWorkflowActions(page, params);

      // Confirmed attribute: data-test="comment-bar__send-btn". Confirmed
      // live that it renders `disabled=""` until required fields are
      // filled -- wait for it to actually become enabled, not just present.
      const sendButton = page.locator('[data-test="comment-bar__send-btn"]');
      if (!(await sendButton.count().catch(() => 0))) {
        throw new Error('No "Send" button found in the ClickUp email composer (data-test="comment-bar__send-btn").');
      }
      const sendEnabled = await sendButton
        .first()
        .waitFor({ state: "attached", timeout: 5000 })
        .then(() => sendButton.first().isEnabled())
        .catch(() => false);
      if (!sendEnabled) {
        throw new Error("Send button is present but disabled -- a required field (To/Subject) is likely still empty or invalid.");
      }
      await sendButton.click();
      await page.waitForTimeout(3000);

      // Clicking Send is never treated as success on its own -- verify the
      // email actually landed in the task's activity/history first.
      const verified = await page
        .getByText(params.subject, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (!verified) {
        throw new Error("Send was clicked but the email could not be confirmed in the task's activity/history -- treating this as a failed send.");
      }

      // Best-effort audit comment ("log every outbound email as a task
      // comment with timestamp + recipient"). The sent email itself already
      // appears in the task history, so a failure here does not undo an
      // already-verified send -- it only means the extra comment is missing.
      await postAuditComment(page, params.to, params.subject).catch((err) => {
        console.warn(`[clickupEmailSender] send verified, but audit comment failed: ${(err as Error).message}`);
      });

      return { messageId: `clickup:${Date.now()}` };
    } finally {
      await Promise.all(tempAttachmentPaths.map((p) => rm(p, { force: true }).catch(() => {})));
      await browser?.close().catch(() => {});
    }
  };
}

/**
 * No-op today. Once the client-to-ClickUp mapping is provided, this is
 * where per-client workflow steps beyond "fill and send an email" get
 * added -- e.g. setting custom fields, changing task status, posting
 * additional attachments. Deliberately not guessed at ahead of that spec.
 */
async function performClientWorkflowActions(_page: Page, _params: SendEmailParams): Promise<void> {}

/**
 * Establishes a scoped locator for the email composer container, anchored
 * on two CONFIRMED-live selectors -- [data-test="email-communicators__subject"]
 * and [data-test="comment-bar__send-btn"] (ClickUp uses the attribute
 * `data-test`, NOT `data-testid` -- confirmed via diagnoseEmailComposer.mjs
 * / quickAttrCheck.mjs on 2026-08-27; a live diagnostic showed the
 * composer's editable-element count settles within 500ms and stays stable
 * for a full 10s afterward, so every earlier "never attached" failure was
 * the wrong attribute name, not a real timing issue) -- by walking up from
 * the Subject input until it contains the Send button too. This lets Body
 * (an ambiguous .ql-editor class, reused for the task description
 * elsewhere on the page) be scoped safely without a page-wide search.
 *
 * This callback is serialized and runs inside the browser page, not Node
 * -- the backend tsconfig has no "dom" lib, so browser globals are reached
 * via `globalThis as any` rather than bare `document` (which TS can't
 * resolve here).
 */
async function getComposerRoot(page: Page, timeoutMs = 8000): Promise<Locator | null> {
  const marker = "data-clickup-agent-composer-root";

  const subject = page.locator('[data-test="email-communicators__subject"]').first();
  if (!(await subject.waitFor({ state: "attached", timeout: timeoutMs }).then(() => true).catch(() => false))) return null;

  const send = page.locator('[data-test="comment-bar__send-btn"]').first();
  if (!(await send.waitFor({ state: "attached", timeout: timeoutMs }).then(() => true).catch(() => false))) return null;

  const found = await page.evaluate((marker: string) => {
    const doc = (globalThis as any).document;
    const subjectEl = doc.querySelector('[data-test="email-communicators__subject"]');
    const sendEl = doc.querySelector('[data-test="comment-bar__send-btn"]');
    if (!subjectEl || !sendEl) return false;
    let node = subjectEl.parentElement;
    while (node && !node.contains(sendEl)) node = node.parentElement;
    if (!node) return false;
    node.setAttribute(marker, "true");
    return true;
  }, marker);
  if (!found) return null;
  return page.locator(`[${marker}]`).first();
}

async function firstMatch(page: Page, candidates: Array<() => Locator>): Promise<Locator | null> {
  for (const candidate of candidates) {
    const locator = candidate();
    if (await locator.count().catch(() => 0)) return locator;
  }
  return null;
}

async function fillFirstMatch(page: Page, candidates: Array<() => Locator>, value: string): Promise<boolean> {
  for (const candidate of candidates) {
    const locator = candidate();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: 3000 });
        await page.keyboard.type(value, { delay: 20 });
        await page.keyboard.press("Enter").catch(() => {});
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

/**
 * Attaches file(s) via the composer's OWN attachment dropdown
 * (data-test="comment-bar__attachment-dropdown-toggle" -- confirmed
 * distinct from data-test="task-view-section-header__add-button-attachments",
 * the unrelated GLOBAL task-attachment button) -- deliberately never grabs
 * a page-wide `input[type=file]`. ClickUp's task view has several unrelated
 * file inputs (global task attachments, avatar upload, etc.); a raw
 * page-wide search once matched a global task-uploader input and caused
 * ClickUp to silently create a brand new task from the attached file.
 *
 * Confirmed live: the composer's file input does NOT support selecting
 * multiple files in one native chooser (a single setFiles([a, b]) call
 * reliably times out waiting for the chooser event) -- so 2+ files are
 * attached one at a time, reopening this same dropdown for each.
 */
async function attachFile(page: Page, filePaths: string | string[]): Promise<boolean> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const attachToggle = page.locator('[data-test="comment-bar__attachment-dropdown-toggle"]');
  if (!(await attachToggle.count().catch(() => 0))) return false;

  for (const singlePath of paths) {
    const attachedOne = await attachOneFile(page, attachToggle, singlePath);
    if (!attachedOne) return false;
    await page.waitForTimeout(500);
  }
  return true;
}

async function attachOneFile(page: Page, attachToggle: Locator, filePath: string): Promise<boolean> {
  try {
    const [fileChooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), attachToggle.click()]);
    await fileChooser.setFiles(filePath);
    return true;
  } catch {
    // No native file chooser fired directly -- a menu (Upload from
    // computer / Google Drive / ...) may have opened instead. Look for an
    // "upload" option inside the newly-opened overlay only.
    await page.waitForTimeout(400);
    const uploadOption = page.locator(".cdk-overlay-container").getByText(/upload|computer|device/i).first();
    if (!(await uploadOption.count().catch(() => 0))) return false;
    try {
      const [fileChooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), uploadOption.click()]);
      await fileChooser.setFiles(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

async function postAuditComment(page: Page, recipients: string[], subject: string): Promise<void> {
  const commentDropdown = await firstMatch(page, [
    () => page.getByRole("button", { name: /^\s*email\s*$/i }),
    () => page.getByText(/^\s*email\s*$/i).first(),
  ]);
  if (commentDropdown) {
    await commentDropdown.click();
    await page.waitForTimeout(300);
    const commentOption = await firstMatch(page, [() => page.getByRole("menuitem", { name: /^\s*comment\s*$/i }), () => page.getByText(/^\s*comment\s*$/i).first()]);
    if (commentOption) {
      await commentOption.click();
      await page.waitForTimeout(300);
    }
  }
  // The same Quill editor class is reused for Comment mode's box too, and
  // (like Body above) has no data-test attribute of its own -- match by
  // the confirmed .ql-editor[contenteditable="true"] class, taking the
  // last one on the page since by this point Email mode's composer should
  // no longer be the active one.
  const note = `Report emailed to ${recipients.join(", ")} at ${new Date().toISOString()} (subject: "${subject}")`;
  const commentBox = page.locator('.ql-editor[contenteditable="true"]').last();
  if (await commentBox.count().catch(() => 0)) {
    await commentBox.click({ timeout: 3000 });
    await page.keyboard.type(note, { delay: 10 });
    const postButton = page.locator('[data-test="comment-bar__send-btn"]');
    if (await postButton.count().catch(() => 0)) {
      await postButton.click();
    } else {
      await page.keyboard.press("Enter");
    }
  }
}
