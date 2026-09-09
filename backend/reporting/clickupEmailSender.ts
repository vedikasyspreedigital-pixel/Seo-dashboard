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
//
// Cc support: the toggle click and the input selector below were confirmed
// live on 2026-09-08 against a real ClickUp task (user-provided DOM
// snapshot after manually opening Cc in a real send attempt that correctly
// refused to proceed once the old guessed input selector didn't match).
// Two things the real DOM revealed that the original guess got wrong:
//   1. Cc/Bcc are NOT special-cased like To (which is its own
//      <cu-email-communicators-field data-test="email-communicators__to">
//      with class cu-email-communicators__field-row--to). Cc/Bcc instead
//      render through a generic templated field-row, and the one open
//      instance is identified by a stable id ClickUp assigns per field
//      type: the recipients drop-list container carries id="cc-0" (Bcc
//      would presumably be "bcc-0").
//   2. The input's class is `cu-search_input` (SINGLE underscore) --
//      different from To's confirmed `cu-search__input` (double
//      underscore). Not a typo in either place; genuinely two different
//      components with two different class names.

import { chromium, type Browser, type Page, type Locator } from "playwright";
import { writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SendEmailFn, SendEmailParams, SendEmailResult } from "./emailSender.js";

export interface ClickUpEmailSenderOptions {
  /** Path to the storageState JSON produced by setupSession.mjs. */
  sessionStatePath: string;
  /** Defaults to true (headless) -- this runs as a backend service, not an interactive spike. */
  headless?: boolean;
  /**
   * When true, does everything up through attaching files to the composer,
   * then stops -- never clicks Send, never posts the audit comment, never
   * throws for a missing/disabled Send button. Not wired into
   * approveAndSendReport's normal call path (that function always calls
   * markSent right after sendEmail resolves, which would be WRONG for a
   * report that was never actually sent) -- this is for manual, one-off
   * verification scripts only, called directly with hand-built params.
   */
  dryRun?: boolean;
  /** Only used when dryRun is true: where to save a screenshot of the filled/attached composer for manual review. */
  dryRunScreenshotPath?: string;
}

// Playwright's own documented mechanism for surfacing what's actually
// happening inside the browser process (protocol-level browser lifecycle
// events, including the underlying reason a target died) instead of only
// the generic "Target crashed" Playwright itself throws. Set once here
// (not per-call) and only if the environment hasn't already configured its
// own DEBUG scope, so this never clobbers an operator's own setting.
if (!process.env.DEBUG) {
  process.env.DEBUG = "pw:browser";
}

/**
 * Reads container-level (cgroup) memory/CPU limits directly, NOT
 * `os.totalmem()`/`os.cpus()` -- those read host-level /proc data that is
 * NOT container-scoped (confirmed live on this exact Railway container:
 * os.cpus().length and `nproc` report 48 -- the HOST's core count -- while
 * the cgroup CPU quota is only 2.0 vCPU worth of CFS bandwidth, and
 * /proc/meminfo reports ~322GiB total versus a 1000MB cgroup memory.max).
 * Tries cgroup v2 paths first, falls back to v1, and never throws --
 * diagnostic-only, must never affect the real send.
 */
function readContainerResourceLimits(): string {
  const parts: string[] = [];
  try {
    const memUsed = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    const memMax = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    parts.push(`cgroup memory: ${(memUsed / 1024 / 1024).toFixed(0)}MB used / ${memMax === "max" ? "unlimited" : (Number(memMax) / 1024 / 1024).toFixed(0) + "MB"} limit`);
  } catch {
    try {
      const memUsed = Number(readFileSync("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8").trim());
      const memMax = Number(readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim());
      parts.push(`cgroup memory (v1): ${(memUsed / 1024 / 1024).toFixed(0)}MB used / ${(memMax / 1024 / 1024).toFixed(0)}MB limit`);
    } catch {
      parts.push("cgroup memory: unavailable");
    }
  }
  try {
    const cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
    const [quota, period] = cpuMax.split(" ");
    parts.push(`cgroup CPU quota: ${quota === "max" ? "unlimited" : `${(Number(quota) / Number(period)).toFixed(2)} vCPU`} (visible cores via os.cpus(): ${os.cpus().length})`);
  } catch {
    parts.push(`cgroup CPU quota: unavailable (visible cores via os.cpus(): ${os.cpus().length})`);
  }
  parts.push(`node process RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);
  return parts.join(" | ");
}

export function createClickUpEmailSender({
  sessionStatePath,
  headless = true,
  dryRun = false,
  dryRunScreenshotPath,
}: ClickUpEmailSenderOptions): SendEmailFn {
  return async function sendViaClickUp(params: SendEmailParams): Promise<SendEmailResult> {
    if (!params.clickupTaskUrl) {
      throw new Error(
        "No ClickUp task resolved for this report -- set clickupTaskUrl on the client's ClientReportConfig (or fill in the ClickUp Task field on the draft) before approving.",
      );
    }
    if (params.to.length === 0) {
      throw new Error("No recipients to send to.");
    }

    // Every "Target crashed" seen in live testing has hit a DIFFERENT step
    // (the Comment dropdown click, the Email menuitem click, even our own
    // pre-click screenshot capture -- once the log showed the debug HTML
    // read failing with "Target crashed" BEFORE the Comment click ever
    // ran) -- that's the signature of the renderer dying for reasons
    // unrelated to any specific selector, not a deterministic bug in one
    // interaction. Retrying the whole attempt with a fresh browser is safe
    // up until Send is actually clicked (nothing has been sent yet, and the
    // subject-based duplicate guard above still protects a retry after
    // that point too) -- sendClicked below is set to true immediately
    // before that click and gates retry off permanently once true, so this
    // can never risk clicking Send twice for the same report.
    const MAX_ATTEMPTS = 2;
    let lastError: Error = new Error("sendViaClickUp: no attempt ran");
    // Set the MOMENT a browser/page 'crash' or 'disconnected' event fires --
    // not inferred from an error message's text (a later, unrelated failure
    // on a subsequent attempt must never let this get silently forgotten).
    // Read at the very end to decide whether the final thrown error needs
    // to say so explicitly, so a real browser crash can never come out the
    // other end looking like an ordinary "Task panel never rendered"
    // timeout from a later, non-crash attempt.
    let crashedOnAnyAttempt = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let browser: Browser | undefined;
      // Set right after the page is created, purely so the catch block below
      // can capture debug artifacts -- kept separate from the `const page`
      // used throughout the automation logic itself so none of those
      // arrow-function closures lose TypeScript's non-undefined narrowing.
      let debugPage: Page | undefined;
      let sendClicked = false;
      // True the instant THIS attempt's page/browser actually crashed
      // (event-driven, not inferred) -- gates the post-failure debug
      // capture below off entirely, since attempting a screenshot/content
      // read against a page already known dead just produces more of the
      // exact same "Target crashed" noise instead of new information.
      let pageCrashedThisAttempt = false;
      const tempAttachmentPaths: string[] = [];

      try {
        // --disable-dev-shm-usage: Docker containers (Railway included) default
        // to a 64MB /dev/shm -- Chromium can hit that ceiling and crash a
        // renderer mid-interaction ("Target crashed") instead of raising a
        // normal error. This makes Chromium fall back to /tmp for shared
        // memory files. --no-sandbox/--disable-setuid-sandbox are paired with
        // it because the sandbox needs kernel privileges this container
        // doesn't grant (it isn't Playwright's own preconfigured Docker
        // image) -- without them, launch can fail outright.
        //
        // Confirmed NOT a memory-limit problem: Railway's own Metrics tab
        // showed ~300MB used of a 1000MB limit, and low CPU, during a run
        // that still hit "Target crashed" -- so a wider set of "low-memory"
        // flags (--disable-gpu, --no-zygote, etc.) was tried and removed
        // again here. That guess was actively counterproductive: this
        // Playwright version resolves to a recent Chromium (1.62.x) using
        // "new" headless mode, where --disable-gpu forces software rendering
        // paths that new headless doesn't expect, which can itself destabilize
        // compositor-heavy UI -- and the crash was reproducibly on ClickUp's
        // animated CDK dropdown menu (Comment/Email mode switcher) both
        // before and after adding those flags. reducedMotion below targets
        // that directly: many Angular CDK components skip their open/close
        // transition entirely under prefers-reduced-motion, which sidesteps
        // whatever in that transition is crashing the renderer without
        // needing to identify the exact Chromium bug.
        //
        // Confirmed NOT a missing-system-dependency problem either: Railway's
        // build log (railway logs --build) shows `npx playwright install
        // --with-deps chromium` installing every core Chromium runtime
        // library (libnss3, libatk-bridge2.0-0, libgbm1, libasound2,
        // libx11-xcb1, libxcomposite1, libxdamage1, libxfixes3, libxrandr2,
        // libcups2, libxkbcommon0) plus a full font set, with zero apt
        // errors -- a genuinely clean, complete --with-deps install.
        const launchArgs = ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"];
        console.error(`[clickupEmailSender] attempt ${attempt}/${MAX_ATTEMPTS}: launching chromium (headless=${headless}, args=${JSON.stringify(launchArgs)}) | ${readContainerResourceLimits()}`);
        browser = await chromium.launch({ headless, args: launchArgs });
        console.error(`[clickupEmailSender] attempt ${attempt}: chromium launched, version=${browser.version()} | ${readContainerResourceLimits()}`);
        // Fires if the whole browser process itself disconnects/dies --
        // distinct from (usually more severe than) a single page's 'crash'
        // event below, which is scoped to one renderer target.
        browser.on("disconnected", () => {
          console.error(`[clickupEmailSender] attempt ${attempt}: browser 'disconnected' event at ${new Date().toISOString()} | ${readContainerResourceLimits()}`);
        });
        const context = await browser.newContext({ storageState: sessionStatePath, reducedMotion: "reduce" });
        const page = await context.newPage();
        debugPage = page;
        page.on("crash", () => {
          pageCrashedThisAttempt = true;
          crashedOnAnyAttempt = true;
          console.error(`[clickupEmailSender] attempt ${attempt}: page 'crash' event at ${new Date().toISOString()} (url=${page.url()}) | ${readContainerResourceLimits()}`);
        });
        page.on("close", () => {
          console.error(`[clickupEmailSender] attempt ${attempt}: page 'close' event at ${new Date().toISOString()}`);
        });

        console.error(`[clickupEmailSender] attempt ${attempt}: about to navigate to ${params.clickupTaskUrl} | ${readContainerResourceLimits()}`);
        await page.goto(params.clickupTaskUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1000);
        if (/login|auth/i.test(page.url())) {
          throw new Error(
            `ClickUp session expired (redirected to ${page.url()}). Re-run "npm run setup-session" in spikes/clickup-feasibility to refresh it.`,
          );
        }

        // ClickUp is a heavy SPA -- the URL resolving and the task panel
        // actually rendering are two different things, so this polls for
        // real task-view content rather than trusting a fixed sleep. 45s (up
        // from an original 20s) -- a live run on Railway's container hit this
        // exact timeout with no crash/error, just ClickUp's heavy Angular SPA
        // genuinely taking longer than 20s to render on a cold, GPU-less
        // headless load than it ever did testing locally on a desktop.
        const taskViewLoaded = await page
          .getByText(/^(Status|Assignees|Priority)$/i)
          .first()
          .waitFor({ state: "visible", timeout: 45000 })
          .then(() => true)
          .catch(() => false);
        if (!taskViewLoaded) {
          throw new Error(`Task panel never rendered recognizable content (Status/Assignees/Priority) within 45s at ${page.url()}.`);
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
          // Scoped to the composer bar (anchored on the confirmed-stable
          // Send button + cdk-menu-trigger attributes -- see
          // getComposerBarRoot) instead of an unscoped page-wide search, so
          // a fallback can never accidentally match some OTHER "Comment"
          // text elsewhere in ClickUp's UI (a tab label, a sidebar count,
          // etc.) -- a real risk with the old getByText(/comment/i).first()
          // used against the whole page. null root (composer bar not found
          // at all) falls back to page-wide as a last resort only.
          const barRoot = await getComposerBarRoot(page);
          const barScope = barRoot ?? page;
          const commentDropdown = await firstMatch(page, [
            () => page.getByRole("button", { name: /^\s*comment\s*$/i }),
            () => barScope.locator('[aria-haspopup="menu"].cdk-menu-trigger').first(),
            () => barScope.getByText(/^\s*comment\s*$/i).first(),
          ]);
          if (!commentDropdown) {
            throw new Error('Could not find the "Comment" mode control on the ClickUp task, and not already in Email mode -- page layout may have changed.');
          }
          // dispatchEvent (native click event, no pointer simulation) over
          // Playwright's normal .click() (real hover/mousedown/mouseup via
          // CDP) -- tried after a prior crash's call log confirmed the
          // locator was already finding the right element (aria-haspopup=
          // "menu"/cdk-menu-trigger), which ruled out a wrong-selector
          // cause. This didn't eliminate the crash on its own (still seen
          // live after this change), which is WHY the retry loop above
          // exists -- the actual fix for "this occasionally crashes the
          // renderer" is tolerating and retrying it, not preventing it.
          await captureDebugArtifactsBefore(page, sessionStatePath, "comment-click");
          await commentDropdown.dispatchEvent("click");
          await page.waitForTimeout(500);

          // The opened menu panel is an Angular CDK overlay -- portaled to
          // .cdk-overlay-container at the end of <body>, NOT nested inside
          // the composer bar it was triggered from (confirmed by this same
          // file's attachFile(), which already relies on that exact
          // container for the attachment upload menu). Scoping here
          // instead of a page-wide getByText -- same reasoning as above.
          const overlay = page.locator(".cdk-overlay-container");
          const emailOption = await firstMatch(page, [
            () => page.getByRole("menuitem", { name: /^\s*email\s*$/i }),
            () => page.getByRole("option", { name: /^\s*email\s*$/i }),
            () => overlay.getByText(/^\s*email\s*$/i).first(),
          ]);
          if (!emailOption) throw new Error('Could not find "Email" in the Comment mode menu -- Email mode may not be enabled for this task/workspace.');
          await captureDebugArtifactsBefore(page, sessionStatePath, "email-click");
          await emailOption.dispatchEvent("click");
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

        // Pre-send duplicate guard: before filling/sending anything, check
        // whether an email with this EXACT subject already exists in this
        // task's activity history. This is what protects a RETRY after a
        // "send was clicked but verification failed/timed out" failure from
        // blindly resending -- if the original click actually landed, this
        // catches it here instead of re-clicking Send.
        //
        // Confirmed via a real read-only inspection of this exact task
        // (spikes/clickup-feasibility/diagnoseActivityHistory.mjs, run
        // 2026-09-09): every sent email renders as its own comment entry
        // carrying a stable, ClickUp-assigned data-comment-id -- but that
        // same inspection ALSO found two already-sent emails in this task
        // with the IDENTICAL subject text (two different runs for the same
        // client happened to complete on the same calendar day, so the
        // deterministic "<start> to <end>" subject collided). That rules out
        // subject-matching as a perfectly unique key on its own. It's still
        // used here because it's the strongest check available without
        // parsing ClickUp's fuzzy relative timestamps ("Yesterday at
        // 5:11 pm") or predicting a comment id ClickUp only assigns AFTER a
        // send succeeds -- and a same-subject false positive only ever makes
        // this check MORE cautious (refuses to send, asks a human to check
        // ClickUp), never less. Runs on every attempt, not just retries --
        // cheap, and a genuine first attempt should almost always find
        // nothing. The matched entry's data-comment-id (when found) is
        // included in the thrown error so a human has an exact, unambiguous
        // reference to go check in ClickUp, even though the automated check
        // itself doesn't need to resolve identity perfectly to do its job.
        const existingSubjectMatch = page.getByText(params.subject, { exact: true }).first();
        const alreadySent = await existingSubjectMatch.isVisible().catch(() => false);
        if (alreadySent) {
          const existingCommentId = await existingSubjectMatch
            .evaluate((el) => el.closest("[data-comment-id]")?.getAttribute("data-comment-id") ?? null)
            .catch(() => null);
          throw new Error(
            `An email with this exact subject ("${params.subject}") already appears in this task's history` +
              (existingCommentId ? ` (ClickUp comment id ${existingCommentId})` : "") +
              ` -- refusing to send again automatically. Verify in ClickUp whether this report was already delivered before retrying.`,
          );
        }

        // Confirmed real, auto-focused input -- no toggle click.
        const toFilled = await fillFirstMatch(
          page,
          [() => page.locator('.cu-email-communicators__field-row--to input.cu-search__input')],
          params.to.join(", "),
        );
        if (!toFilled) throw new Error('Could not find/fill the "To" input (.cu-email-communicators__field-row--to input.cu-search__input).');

        // CC -- ONLY attempted when cc recipients are actually configured, so a
        // report with no cc never touches this UI at all. Confirmed live
        // 2026-09-08 (see comment above): the open Cc row is identified by
        // id="cc-0" on its recipients drop-list container, with the actual
        // input matched by class cu-search_input (single underscore) inside
        // it. If cc recipients are configured but the toggle/field can't be
        // found, this throws and fails the whole send -- it never silently
        // sends without the configured cc.
        if (params.cc && params.cc.length > 0) {
          const alreadyHasCcField = await composerRoot
            .locator('[id^="cc-"] input.cu-search_input')
            .first()
            .isVisible()
            .catch(() => false);
          if (!alreadyHasCcField) {
            const ccToggle = await firstMatch(page, [
              () => composerRoot.getByText(/^\s*cc\s*$/i),
              () => composerRoot.locator('[aria-label*="cc" i]'),
              () => composerRoot.getByRole("button", { name: /^\s*cc\s*$/i }),
            ]);
            if (!ccToggle) {
              throw new Error(
                'Cc recipients are configured for this report, but no "Cc" toggle could be found in the composer -- refusing to send without cc rather than silently dropping it.',
              );
            }
            await ccToggle.click();
            await page.waitForTimeout(300);
          }

          const ccFilled = await fillFirstMatch(
            page,
            [() => composerRoot.locator('[id^="cc-"] input.cu-search_input'), () => composerRoot.locator('[id^="cc-"] input')],
            params.cc.join(", "),
          );
          if (!ccFilled) {
            throw new Error(
              'Cc recipients are configured for this report, but the Cc input could not be found/filled after opening it -- refusing to send without cc.',
            );
          }
        }

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

        if (dryRun) {
          // Everything up to and including the attachment is done and
          // verified on the real page -- stop here deliberately. Never
          // touches the Send button, never posts the audit comment.
          if (dryRunScreenshotPath) {
            await page.screenshot({ path: dryRunScreenshotPath, fullPage: false }).catch(() => {});
          }
          return { messageId: `clickup-dry-run:${Date.now()}` };
        }

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
        // Set BEFORE the click, not after -- if the click call itself throws
        // or crashes the renderer, we still must never retry: a crash mid-
        // click can't tell us whether the click landed before the renderer
        // died, so treating it as "maybe sent" (no automatic retry) is the
        // only safe assumption. A human retry is still safe either way, via
        // the subject-based duplicate guard above.
        sendClicked = true;
        await sendButton.click();
        await page.waitForTimeout(3000);

        // Clicking Send is never treated as success on its own -- verify the
        // email actually landed in the task's activity/history first.
        const verified = await page
          .getByText(params.subject, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 45000 })
          .then(() => true)
          .catch(() => false);
        if (!verified) {
          throw new Error("Send was clicked but the email could not be confirmed in the task's activity/history -- treating this as a failed send.");
        }

        // Best-effort audit comment ("log every outbound email as a task
        // comment with timestamp + recipient"). The sent email itself already
        // appears in the task history, so a failure here does not undo an
        // already-verified send, does not throw, and never turns a real SENT
        // into a SEND_FAILED -- it only means the extra comment is missing.
        // That outcome is still worth knowing later (this is exactly the gap
        // hit tracing a real send with nothing but a console.warn line to go
        // on), so it's returned as part of the result instead of only logged.
        const auditCommentPosted = await postAuditComment(page, composerRoot, params.to, params.subject)
          .then(() => true)
          .catch((err) => {
            console.warn(`[clickupEmailSender] send verified, but audit comment failed: ${(err as Error).message}`);
            return false;
          });

        return { messageId: `clickup:${Date.now()}`, auditCommentPosted };
      } catch (err) {
        // Debug artifacts, not user-facing behavior: a screenshot + full DOM
        // dump of whatever the page actually looked like at the moment of
        // failure, saved next to the session file on the persistent volume
        // (survives the browser closing in `finally` below, and is fetchable
        // afterward via `railway ssh ... cat`). Added after several live
        // failures whose only evidence was a generic Playwright error message
        // -- e.g. "Could not find Email in the Comment mode menu" gives no
        // way to tell whether the menu never opened, opened empty, or opened
        // with different wording, without seeing the actual page.
        //
        // Skipped entirely once the 'crash' listener above already fired for
        // THIS attempt -- we already have definitive, immediate proof the
        // page is dead; attempting a screenshot/content read against it
        // just produces more identical "Target crashed" log lines instead
        // of new information, obscuring the one signal that actually
        // matters (the crash event itself) under repeated noise.
        if (pageCrashedThisAttempt) {
          console.error(`[clickupEmailSender] attempt ${attempt}: skipping debug capture -- page already confirmed crashed (see 'crash' event above).`);
        } else {
          await captureDebugArtifacts(debugPage, sessionStatePath).catch(() => {});
        }
        lastError = err as Error;
        // Only ever retry a failure that happened BEFORE Send was clicked --
        // see the sendClicked comment above for why anything after that
        // point must propagate immediately instead.
        if (!sendClicked && attempt < MAX_ATTEMPTS) {
          console.warn(
            `[clickupEmailSender] attempt ${attempt}/${MAX_ATTEMPTS} failed before Send was clicked ` +
              `(${pageCrashedThisAttempt ? "BROWSER CRASHED: " : ""}${lastError.message}) -- retrying with a fresh browser.`,
          );
        } else {
          throw enrichWithCrashContext(err as Error, crashedOnAnyAttempt);
        }
      } finally {
        await Promise.all(tempAttachmentPaths.map((p) => rm(p, { force: true }).catch(() => {})));
        // Logged explicitly (not just swallowed) so a hang or failure IN
        // close() itself -- e.g. the browser process wedged after its
        // renderer crashed -- is visible rather than silently absorbed,
        // per the requirement to confirm the crashed browser is actually
        // fully closed before any retry launches a new one.
        await browser
          ?.close()
          .then(() => console.error(`[clickupEmailSender] attempt ${attempt}: browser closed.`))
          .catch((e) => console.error(`[clickupEmailSender] attempt ${attempt}: browser.close() itself failed: ${(e as Error).message}`));
      }
    }
    // Unreachable: the loop above always either returns (success) or throws
    // (final attempt exhausted, or a post-Send failure) -- this only
    // satisfies TypeScript's control-flow analysis, which can't see that.
    throw enrichWithCrashContext(lastError, crashedOnAnyAttempt);
  };
}

/**
 * Ensures a real browser/page crash can never come out the other end
 * looking like an ordinary application-level error (e.g. a LATER, non-crash
 * attempt's "Task panel never rendered..." timeout) -- if ANY attempt's
 * 'crash'/'disconnected' event fired, the thrown error explicitly says so
 * up front, with the actual final error's message preserved after it, never
 * replaced.
 */
function enrichWithCrashContext(err: Error, crashedOnAnyAttempt: boolean): Error {
  if (!crashedOnAnyAttempt) return err;
  return new Error(
    `Chromium's renderer crashed (browser 'crash'/'disconnected' event observed) during at least one attempt -- ` +
      `this is a browser/container stability issue, not a ClickUp UI change. Final error after retry: ${err.message}`,
  );
}

/**
 * Saves a screenshot + full HTML dump of `page` next to the session file on
 * the persistent volume (same directory as sessionStatePath), timestamped so
 * repeated failures don't overwrite each other. Deliberately swallows its
 * own errors at every step (a failed debug capture must never mask or
 * replace the real error this is trying to help diagnose) and no-ops if
 * `page` was never created (failure happened before context/page setup) --
 * but unlike an earlier version of this function, it reports HONESTLY
 * whether each write actually succeeded rather than always claiming
 * "saved". That bug mattered here specifically: after a real "Target
 * crashed" renderer death, page.screenshot()/page.content() themselves
 * fail (there's no renderer left to read from) -- a post-crash capture
 * attempt logged "saved" for two files that were never written. For a true
 * render-crash, see captureDebugArtifactsBefore below instead, which
 * captures state BEFORE the risky click, while the renderer is still alive.
 */
async function captureDebugArtifacts(page: Page | undefined, sessionStatePath: string): Promise<void> {
  if (!page) return;
  const dir = path.dirname(sessionStatePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(dir, `debug-failure-${stamp}.png`);
  const htmlPath = path.join(dir, `debug-failure-${stamp}.html`);
  const screenshotOk = await page
    .screenshot({ path: screenshotPath, fullPage: true })
    .then(() => true)
    .catch((e) => {
      console.error(`[clickupEmailSender] debug screenshot capture failed: ${(e as Error).message}`);
      return false;
    });
  const htmlOk = await page
    .content()
    .then((html) => writeFile(htmlPath, html, "utf8"))
    .then(() => true)
    .catch((e) => {
      console.error(`[clickupEmailSender] debug HTML capture failed: ${(e as Error).message}`);
      return false;
    });
  console.error(`[clickupEmailSender] debug artifacts: screenshot=${screenshotOk ? screenshotPath : "FAILED"} , html=${htmlOk ? htmlPath : "FAILED"}`);
}

/**
 * Captures a screenshot BEFORE a risky action, timestamped with `label` --
 * used to bracket the specific clicks that have repeatedly crashed the
 * renderer (ClickUp's animated Comment/Email mode-switcher menu), since a
 * post-crash capture can never work: by the time an action throws "Target
 * crashed", the renderer is already dead and there's nothing left to read.
 * This shows the exact DOM state one step before whatever kills it. Same
 * swallow-your-own-errors rule as captureDebugArtifacts.
 */
async function captureDebugArtifactsBefore(page: Page, sessionStatePath: string, label: string): Promise<void> {
  const dir = path.dirname(sessionStatePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(dir, `debug-before-${label}-${stamp}.png`);
  const htmlPath = path.join(dir, `debug-before-${label}-${stamp}.html`);
  await page
    .screenshot({ path: screenshotPath, fullPage: true })
    .then(() => console.error(`[clickupEmailSender] pre-action debug screenshot saved: ${screenshotPath}`))
    .catch((e) => console.error(`[clickupEmailSender] pre-action debug screenshot failed: ${(e as Error).message}`));
  // A screenshot alone can't show real attributes/structure -- the whole
  // point of this capture is to stop guessing at selectors, which needs the
  // actual markup, not just a picture of it.
  await page
    .content()
    .then((html) => writeFile(htmlPath, html, "utf8"))
    .then(() => console.error(`[clickupEmailSender] pre-action debug HTML saved: ${htmlPath}`))
    .catch((e) => console.error(`[clickupEmailSender] pre-action debug HTML failed: ${(e as Error).message}`));
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
/**
 * Scoped root for the Comment/Email mode-TRIGGER button, usable even before
 * Email mode is entered (unlike getComposerRoot below, which requires the
 * Subject input that only exists once already in Email mode). Anchored on
 * two attributes CONFIRMED real, not guessed: [data-test="comment-bar__send-btn"]
 * (present in both modes -- visible in a live screenshot of Comment mode),
 * and [aria-haspopup="menu"].cdk-menu-trigger (the actual resolved element
 * a prior live crash's Playwright call log showed for the mode-trigger
 * button). Walks up from Send until an ancestor's subtree also contains a
 * cdk-menu-trigger, the same "walk up until it contains the other known
 * element" technique getComposerRoot uses, just anchored on a different
 * pair since Subject doesn't exist yet outside Email mode. This is what
 * lets the mode-trigger lookup below stop being an unscoped, page-wide
 * getByText("Comment") that could match unrelated "Comment" text anywhere
 * on the page.
 */
async function getComposerBarRoot(page: Page, timeoutMs = 8000): Promise<Locator | null> {
  const marker = "data-clickup-agent-composer-bar-root";
  const send = page.locator('[data-test="comment-bar__send-btn"]').first();
  if (!(await send.waitFor({ state: "attached", timeout: timeoutMs }).then(() => true).catch(() => false))) return null;

  const found = await page.evaluate((marker: string) => {
    const doc = (globalThis as any).document;
    const sendEl = doc.querySelector('[data-test="comment-bar__send-btn"]');
    if (!sendEl) return false;
    let node = sendEl.parentElement;
    while (node && !node.querySelector('[aria-haspopup="menu"].cdk-menu-trigger')) {
      node = node.parentElement;
    }
    if (!node) return false;
    node.setAttribute(marker, "true");
    return true;
  }, marker);
  if (!found) return null;
  return page.locator(`[${marker}]`).first();
}

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

async function postAuditComment(page: Page, composerRoot: Locator, recipients: string[], subject: string): Promise<void> {
  // Scoped to composerRoot (still valid here -- we're still in Email mode,
  // same DOM composerRoot was already established against) instead of a
  // page-wide getByText, same reasoning as the pre-send mode-toggle lookup.
  const commentDropdown = await firstMatch(page, [
    () => page.getByRole("button", { name: /^\s*email\s*$/i }),
    () => composerRoot.locator('[aria-haspopup="menu"].cdk-menu-trigger').first(),
    () => composerRoot.getByText(/^\s*email\s*$/i).first(),
  ]);
  if (commentDropdown) {
    await commentDropdown.dispatchEvent("click");
    await page.waitForTimeout(300);
    // Scoped to the CDK overlay portal, not the page -- same reasoning as
    // the pre-send Email-menuitem lookup above.
    const overlay = page.locator(".cdk-overlay-container");
    const commentOption = await firstMatch(page, [() => page.getByRole("menuitem", { name: /^\s*comment\s*$/i }), () => overlay.getByText(/^\s*comment\s*$/i).first()]);
    if (commentOption) {
      await commentOption.dispatchEvent("click");
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
