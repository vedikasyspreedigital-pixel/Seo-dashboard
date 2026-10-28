import { chromium, type Browser, type Locator, type Page } from "playwright";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { attachFile, firstMatch, getComposerBarRoot, resolveSessionStatePath } from "../reporting/clickupEmailSender.js";
import { markMock } from "../reporting/mockEmailSender.js";

// Domain Intelligence delivery: posts a plain COMMENT (not an email) with the
// report Excel(s) attached on a client's domain-report ClickUp task. Same
// saved-session approach and same scoping rules as the email sender
// (clickupEmailSender.ts): never logs in, never uses page-wide selectors --
// everything is found by walking up from the comment bar's own Send button.
//
// NOT yet confirmed against real ClickUp: the Comment-mode selectors below
// are inferred from the confirmed Email-mode DOM. That's why this has its own
// gate (CLICKUP_COMMENTS_LIVE, see server.ts) instead of riding on
// CLICKUP_EMAIL_LIVE -- switch it on for one test client first.

export interface PostCommentParams {
  /** Bare ClickUp task id, e.g. "86d45e14k". */
  taskId: string;
  workspaceSlug: string | null;
  /** Comment text; lines are typed with Shift+Enter so nothing is sent early. */
  lines: string[];
  /** A unique token included in the comment -- the duplicate guard and the post-send check both look for it. */
  marker: string;
  /** A person to tag: "@<mention>" in a line becomes a real ClickUp mention (picked from ClickUp's own list). */
  mention?: string;
  files: { path: string; name: string }[];
}

export type PostCommentFn = (params: PostCommentParams) => Promise<void>;

export function createMockCommentPoster(): PostCommentFn {
  return markMock<PostCommentFn>(async (params) => {
    console.log(`[domainIntel] MOCK ClickUp comment on task ${params.taskId}: ${params.lines[0]} (+${params.files.length} file(s)) [${params.marker}]`);
  });
}

export interface ClickUpCommentPosterOptions {
  sessionStatePath: string;
  sessionStatePathByWorkspace?: Record<string, string>;
  headless?: boolean;
  /** Local debugging only: save a screenshot right after Send. */
  debugDir?: string;
}

export function createClickUpCommentPoster({ sessionStatePath, sessionStatePathByWorkspace, headless = true, debugDir }: ClickUpCommentPosterOptions): PostCommentFn {
  return async function postComment(params) {
    const statePath = resolveSessionStatePath(params.workspaceSlug, sessionStatePathByWorkspace, sessionStatePath);
    const taskUrl = `https://app.clickup.com/t/${encodeURIComponent(params.taskId)}`;
    // The composer names the attachment after the file on disk, so copy each
    // report to its client-facing name first.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "domain-intel-"));
    let browser: Browser | undefined;
    try {
      const uploadPaths: string[] = [];
      for (const file of params.files) {
        const dest = path.join(tempDir, path.basename(file.name));
        await copyFile(file.path, dest);
        uploadPaths.push(dest);
      }

      browser = await chromium.launch({ headless, args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"] });
      const context = await browser.newContext({ storageState: statePath, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
      if (/login|auth/i.test(page.url())) {
        throw new Error(`ClickUp session expired (redirected to ${page.url()}). Refresh it with "npm run setup-session" in spikes/clickup-feasibility.`);
      }
      const loaded = await page
        .getByText(/^(Status|Assignees|Priority)$/i)
        .first()
        .waitFor({ state: "visible", timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (!loaded) throw new Error(`ClickUp task ${params.taskId} never finished loading.`);

      // Duplicate guard: this exact report was already posted (e.g. a retry after a post that did land).
      if (await page.getByText(params.marker).first().isVisible().catch(() => false)) {
        throw new Error(`This report (${params.marker}) already appears on ClickUp task ${params.taskId} -- not posting it twice.`);
      }

      await ensureCommentMode(page);
      const editor = await getCommentEditor(page);
      if (!editor) throw new Error("Could not find the comment box next to the comment bar's Send button.");

      await editor.click({ timeout: 3000 });
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A");
      for (let i = 0; i < params.lines.length; i++) {
        if (i > 0) await page.keyboard.press("Shift+Enter");
        await typeLine(page, params.lines[i], params.mention);
      }

      if (uploadPaths.length > 0) {
        if (!(await attachFile(page, uploadPaths))) throw new Error("Could not attach the report file(s) through the comment bar's attachment button.");
        for (const file of params.files) {
          const done = await page
            .locator(`[data-test="comment-attachment__blot"].comment-attachment_success[data-file*="${file.name.replace(/"/g, "")}"]`)
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => true)
            .catch(() => false);
          if (!done) throw new Error(`Attachment "${file.name}" didn't finish uploading within 30s -- not posting without it.`);
        }
      }

      const send = page.locator('[data-test="comment-bar__send-btn"]').first();
      if (!(await send.isEnabled().catch(() => false))) throw new Error("The comment Send button is disabled.");
      await send.click();
      // Posted = the marker shows in a POSTED comment (the activity list), never in the comment box itself:
      // a send that didn't go through left the typed text in the box, and matching that reported a false
      // "Posted to ClickUp" (seen 2026-10-26 -- the comment never appeared).
      const posted = await waitForPostedComment(page, params.marker, 60000);
      if (debugDir) await page.screenshot({ path: path.join(debugDir, `comment-after-send-${Date.now()}.png`) }).catch(() => {});
      if (!posted) {
        const leftInBox = await page.evaluate((m: string) => [...(globalThis as any).document.querySelectorAll('.ql-editor[contenteditable="true"]')].some((e: any) => (e.textContent || "").includes(m)), params.marker);
        throw new Error(
          leftInBox
            ? "Send was clicked but ClickUp didn't post the comment (it's still in the comment box) -- nothing was posted."
            : "Send was clicked but the comment could not be found on the task afterwards -- check ClickUp before retrying.",
        );
      }
    } finally {
      await browser?.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * Types one line; "@<mention>" becomes a real mention: type "@" + first name, then click the person in
 * ClickUp's suggestion list (looked up inside the overlay only -- never page-wide). If the list doesn't
 * offer them, the rest of the name is typed as plain text and the comment still goes out.
 */
async function typeLine(page: Page, line: string, mention: string | undefined): Promise<void> {
  const token = mention ? `@${mention}` : null;
  const at = token ? line.indexOf(token) : -1;
  if (!token || at < 0) {
    await page.keyboard.type(line, { delay: 15 });
    return;
  }
  await page.keyboard.type(line.slice(0, at), { delay: 15 });
  const first = mention!.split(" ")[0];
  await page.keyboard.type(`@${first}`, { delay: 60 });
  const overlay = page.locator(".cdk-overlay-container, [role='listbox'], [class*='mention']");
  // The suggestion list takes a moment to appear.
  let option: Locator | null = null;
  for (let i = 0; i < 12 && !option; i++) {
    await page.waitForTimeout(500);
    option = await firstMatch(page, [
      () => overlay.getByRole("option", { name: new RegExp(mention!, "i") }).first(),
      () => overlay.getByText(new RegExp(`^\\s*${mention}\\s*$`, "i")).first(),
    ]).catch(() => null);
  }
  let tagged = false;
  if (option) {
    tagged = await option
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!tagged) {
    console.warn(`[domainIntel] ClickUp didn't offer "${mention}" to tag -- writing the name as plain text.`);
    await page.keyboard.type(mention!.slice(first.length), { delay: 15 });
  }
  await page.waitForTimeout(300);
  await page.keyboard.type(line.slice(at + token.length), { delay: 15 });
}

/** Waits until `marker` is visible inside a posted comment -- not inside an editable comment box. */
async function waitForPostedComment(page: Page, marker: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await page
      .evaluate((m: string) => {
        const doc = (globalThis as any).document;
        const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
        let n: any;
        while ((n = walker.nextNode())) {
          if (!(n.textContent || "").includes(m)) continue;
          const el = n.parentElement;
          if (el?.closest('[contenteditable="true"]')) continue; // still in a comment box
          if (el?.closest('.cu-comment-viewer-content, [class*="message-body"], [data-test*="comment"]')) return true;
        }
        return false;
      }, marker)
      .catch(() => false);
    if (found) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

/** The composer's mode is sticky per user; if it was left on Email, switch it back to Comment through its own menu. */
async function ensureCommentMode(page: Page): Promise<void> {
  const inEmailMode = await page.locator('[data-test="email-communicators__subject"]').first().isVisible().catch(() => false);
  if (!inEmailMode) return;
  const bar = await getComposerBarRoot(page);
  if (!bar) throw new Error("The composer is in Email mode and its mode menu could not be found.");
  const trigger = bar.locator('[aria-haspopup="menu"].cdk-menu-trigger').first();
  await trigger.dispatchEvent("click");
  await page.waitForTimeout(500);
  const overlay = page.locator(".cdk-overlay-container");
  const commentOption = await firstMatch(page, [
    () => overlay.getByRole("menuitem", { name: /^\s*comment\s*$/i }),
    () => overlay.getByText(/^\s*comment\s*$/i).first(),
  ]);
  if (!commentOption) throw new Error('Could not find "Comment" in the composer mode menu.');
  await commentOption.dispatchEvent("click");
  await page.waitForTimeout(800);
}

/** Walks up from the comment bar's Send button to the nearest ancestor holding an editor -- never the task description's editor. */
async function getCommentEditor(page: Page): Promise<Locator | null> {
  const marker = "data-domain-intel-comment-root";
  const found = await page.evaluate((marker: string) => {
    const doc = (globalThis as any).document;
    const sendEl = doc.querySelector('[data-test="comment-bar__send-btn"]');
    let node = sendEl?.parentElement;
    while (node && !node.querySelector('.ql-editor[contenteditable="true"]')) node = node.parentElement;
    if (!node) return false;
    node.setAttribute(marker, "true");
    return true;
  }, marker);
  return found ? page.locator(`[${marker}] .ql-editor[contenteditable="true"]`).first() : null;
}
