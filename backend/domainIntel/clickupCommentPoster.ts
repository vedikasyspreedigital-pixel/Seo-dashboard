import { chromium, type Browser, type Locator, type Page } from "playwright";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { attachFile, firstMatch, getComposerBarRoot, resolveSessionStatePath } from "../reporting/clickupEmailSender.js";

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
  files: { path: string; name: string }[];
}

export type PostCommentFn = (params: PostCommentParams) => Promise<void>;

export function createMockCommentPoster(): PostCommentFn {
  return async (params) => {
    console.log(`[domainIntel] MOCK ClickUp comment on task ${params.taskId}: ${params.lines[0]} (+${params.files.length} file(s)) [${params.marker}]`);
  };
}

export interface ClickUpCommentPosterOptions {
  sessionStatePath: string;
  sessionStatePathByWorkspace?: Record<string, string>;
  headless?: boolean;
}

export function createClickUpCommentPoster({ sessionStatePath, sessionStatePathByWorkspace, headless = true }: ClickUpCommentPosterOptions): PostCommentFn {
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
        const dest = path.join(tempDir, file.name);
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
        await page.keyboard.type(params.lines[i], { delay: 15 });
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
      const posted = await page
        .getByText(params.marker)
        .first()
        .waitFor({ state: "visible", timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (!posted) throw new Error("Send was clicked but the comment could not be found on the task afterwards -- check ClickUp before retrying.");
    } finally {
      await browser?.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
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
