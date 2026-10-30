import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { markEmailModeTab } from "../backend/reporting/clickupEmailSender.js";

// 2026-10-30: ClickUp moved Email out of the Comment dropdown into a tab row (Comment | Post | Email)
// above the composer, and every send failed with 'Could not find "Email" in the Comment mode menu'.
// These run the real in-page finder in Chromium against stand-ins of both layouts.

const MARKER = "data-clickup-agent-email-tab";

const history = `
  <div class="activity">
    <div data-comment-id="c1"><div class="cu-comment"><button>Email</button><span>Older email</span></div></div>
  </div>`;

const tabLayout = `
  ${history}
  <div class="comment-bar">
    <div class="tabs"><button>Comment</button><button>Post</button><button id="email-tab"><span>Email</span></button></div>
    <div class="box">
      <div class="ql-editor" contenteditable="true"><p>Email</p></div>
      <button data-test="comment-bar__send-btn">Send</button>
    </div>
  </div>`;

const dropdownLayout = `
  ${history}
  <div class="comment-bar">
    <button aria-haspopup="menu" class="cdk-menu-trigger">Comment</button>
    <div class="ql-editor" contenteditable="true"><p>Email</p></div>
    <button data-test="comment-bar__send-btn">Send</button>
  </div>
  <div class="cdk-overlay-container"><div role="menuitem">Email</div></div>`;

async function withPage(html: string, fn: (page: import("playwright").Page) => Promise<void>) {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html);
    await fn(page);
  } finally {
    await browser?.close();
  }
}

test("email mode tab: the new Comment | Post | Email tab row -> marks the composer's Email tab", async () => {
  await withPage(tabLayout, async (page) => {
    assert.equal(await page.evaluate(markEmailModeTab, MARKER), true);
    assert.equal(await page.locator(`[${MARKER}]`).count(), 1);
    assert.equal(await page.locator(`[${MARKER}]`).getAttribute("id"), "email-tab");
  });
});

// Shape of the live page from the 2026-10-30 failure snapshot: role="tab" + data-test on each tab,
// with the tab row 11 levels above the Send button (the first fix only looked 8 levels up).
const nest = (inner: string, levels: number) => "<div>".repeat(levels) + inner + "</div>".repeat(levels);
const liveLayout = `
  ${history}
  <div class="comment-bar">
    <div role="tablist">
      <button role="tab" data-test="comment-bar__compose-tab-message">Comment</button>
      <button role="tab" data-test="comment-bar__compose-tab-post">Post</button>
      <button role="tab" id="email-tab" data-test="comment-bar__compose-tab-email"><span class="tab-label"> Email </span></button>
    </div>
    ${nest(`<div class="ql-editor" contenteditable="true"></div><button data-test="comment-bar__send-btn">Send</button>`, 10)}
  </div>`;

test("email mode tab: ClickUp's live tab row (data-test, 11 levels above Send) -> marks the Email tab", async () => {
  await withPage(liveLayout, async (page) => {
    assert.equal(await page.evaluate(markEmailModeTab, MARKER), true);
    assert.equal(await page.locator(`[${MARKER}]`).getAttribute("id"), "email-tab");
  });
});

test("email mode tab: the old dropdown layout -> finds nothing, so the sender falls back to the menu", async () => {
  await withPage(dropdownLayout, async (page) => {
    assert.equal(await page.evaluate(markEmailModeTab, MARKER), false, "not the history's Email, the typed body, or the overlay menu");
    assert.equal(await page.locator(`[${MARKER}]`).count(), 0);
  });
});

test("email mode tab: no composer on the page -> nothing is marked", async () => {
  await withPage(history, async (page) => {
    assert.equal(await page.evaluate(markEmailModeTab, MARKER), false);
  });
});
