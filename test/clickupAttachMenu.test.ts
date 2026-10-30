import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { attachFile } from "../backend/reporting/clickupEmailSender.js";

// 2026-10-30: every report send failed with "Could not attach the report/Excel files via the composer's own
// attachment dropdown". ClickUp's paperclip now opens "Upload file / Dropbox / OneDrive/SharePoint / Box /
// Google Drive / New Google Doc" inside its own <cu-cloud-buttons-dropdown>, not in .cdk-overlay-container
// where the sender looked. These run the real attachFile in Chromium against stand-ins of both menus, with a
// decoy "Upload file" in the task's attachments section that must never be used.

const decoy = `
  <div class="task-attachments">
    <button id="decoy" onclick="document.getElementById('decoy-input').click()">Upload file</button>
    <input id="decoy-input" type="file" style="display:none" />
  </div>`;

const menuItems = (onUpload: string) => `
  <div class="cu-dropdown__menu" role="menu">
    <div class="item" onclick="${onUpload}"><span>Upload file</span></div>
    <div class="item" onclick="window.clicked='dropbox'">Dropbox</div>
    <div class="item" onclick="window.clicked='drive'">Google Drive</div>
    <div class="item" onclick="window.clicked='doc'">New Google Doc</div>
  </div>`;

// New layout: the menu appears inside the paperclip's own dropdown.
const inlineMenuLayout = `
  ${decoy}
  <div class="comment-bar">
    <cu-cloud-buttons-dropdown>
      <div class="cu-dropdown">
        <button data-test="comment-bar__attachment-dropdown-toggle"
          onclick="this.parentElement.insertAdjacentHTML('beforeend', document.getElementById('menu-tpl').innerHTML)">clip</button>
      </div>
    </cu-cloud-buttons-dropdown>
    <input id="composer-input" type="file" style="display:none" />
    <button data-test="comment-bar__send-btn">Send</button>
  </div>
  <template id="menu-tpl">${menuItems("document.getElementById('composer-input').click()")}</template>`;

// Old layout: the menu is portaled into .cdk-overlay-container.
const overlayMenuLayout = `
  ${decoy}
  <div class="comment-bar">
    <button data-test="comment-bar__attachment-dropdown-toggle"
      onclick="document.querySelector('.cdk-overlay-container').innerHTML = document.getElementById('menu-tpl').innerHTML">clip</button>
    <input id="composer-input" type="file" style="display:none" />
  </div>
  <div class="cdk-overlay-container"></div>
  <template id="menu-tpl">${menuItems("document.getElementById('composer-input').click()")}</template>`;

async function withPage(html: string, fn: (page: import("playwright").Page, files: string[]) => Promise<void>) {
  let browser: Browser | undefined;
  const dir = await mkdtemp(path.join(os.tmpdir(), "attach-test-"));
  try {
    const files = [path.join(dir, "AKT - Keyword Ranking Report.pdf"), path.join(dir, "extra.pdf")];
    for (const f of files) await writeFile(f, "%PDF-1.4 test");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html);
    // What the "native file chooser" put each file into -- the composer's input or the decoy's.
    await page.evaluate(() => {
      const w = globalThis as any;
      w.received = [];
      for (const id of ["composer-input", "decoy-input"]) {
        w.document.getElementById(id)?.addEventListener("change", (e: any) => {
          for (const f of e.target.files) w.received.push(`${id}:${f.name}`);
        });
      }
    });
    await fn(page, files);
  } finally {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("attach: ClickUp's new paperclip menu (inside its own dropdown) -> 'Upload file' puts each file in the composer", async () => {
  await withPage(inlineMenuLayout, async (page, files) => {
    assert.equal(await attachFile(page, files), true);
    assert.deepEqual(await page.evaluate(() => (globalThis as any).received), ["composer-input:AKT - Keyword Ranking Report.pdf", "composer-input:extra.pdf"]);
    assert.equal(await page.evaluate(() => (globalThis as any).clicked), undefined, "never Dropbox, Drive or a new Google Doc");
  });
});

test("attach: the older overlay menu still works", async () => {
  await withPage(overlayMenuLayout, async (page, files) => {
    assert.equal(await attachFile(page, files.slice(0, 1)), true);
    assert.deepEqual(await page.evaluate(() => (globalThis as any).received), ["composer-input:AKT - Keyword Ranking Report.pdf"]);
  });
});

test("attach: no paperclip in the composer -> refuses, and never uses the task's own 'Upload file'", async () => {
  await withPage(`${decoy}<div class="comment-bar"><button data-test="comment-bar__send-btn">Send</button></div>`, async (page, files) => {
    assert.equal(await attachFile(page, files), false);
    assert.deepEqual(await page.evaluate(() => (globalThis as any).received), []);
  });
});
