import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { allPostedEntryIds, postedEntryIdsWithSubject } from "../backend/reporting/clickupEmailSender.js";

// Audit 2026-10-27: after Send, the email sender accepted the subject ANYWHERE on the page -- the unsent
// composer, or an older email whose subject contains it -- so an email that never went out could be
// marked SENT. These run the real in-page matcher in Chromium against a stand-in of ClickUp's task page
// (the same data-comment-id / data-test attributes the sender relies on).

const SUBJECT = "Twin Crown - Keyword Ranking Report (1st to 30th Sep 2026)";

const taskPage = ({ history, composerBody = "", composerSubject = "" }: { history: [string, string][]; composerBody?: string; composerSubject?: string }) => `
  <div class="activity">
    ${history.map(([id, text]) => `<div data-comment-id="${id}"><div class="cu-comment"><b>Email</b><span>${text}</span></div></div>`).join("")}
  </div>
  <div data-clickup-agent-composer-root="true">
    <input data-test="email-communicators__subject" value="${composerSubject}" />
    <div class="ql-editor" contenteditable="true">${composerBody}</div>
    <button data-test="comment-bar__send-btn">Send</button>
  </div>`;

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

test("email verification: the subject sitting in the unsent composer is NOT a sent email", async () => {
  await withPage(taskPage({ history: [["c1", "Older update"]], composerSubject: SUBJECT, composerBody: `Hi team, ${SUBJECT}` }), async (page) => {
    assert.deepEqual(await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: false }), []);
    assert.deepEqual(await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: true }), [], "nor does it trip the duplicate guard");
  });
});

test("email verification: an older email whose subject CONTAINS this one never confirms this send", async () => {
  await withPage(taskPage({ history: [["c1", `${SUBJECT} (Updated 2)`]] }), async (page) => {
    const before = new Set(await page.evaluate(allPostedEntryIds));
    const ids = await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: false });
    assert.deepEqual(ids, ["c1"], "it matches as text...");
    assert.equal(ids.some((id) => !before.has(id)), false, "...but it was there before Send, so it's not the new email");
    assert.deepEqual(await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: true }), [], "and it isn't an exact duplicate");
  });
});

test("email verification: a NEW posted entry with the subject confirms the send; an exact one trips the duplicate guard", async () => {
  await withPage(taskPage({ history: [["c1", "Older update"]] }), async (page) => {
    const before = new Set(await page.evaluate(allPostedEntryIds));
    await page.evaluate((subject) => {
      const doc = (globalThis as any).document;
      const entry = doc.createElement("div");
      entry.setAttribute("data-comment-id", "c2");
      entry.innerHTML = `<div class="cu-comment"><b>Email</b><span></span></div>`;
      entry.querySelector("span").textContent = subject;
      doc.querySelector(".activity").appendChild(entry);
    }, SUBJECT);
    const ids = await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: false });
    assert.deepEqual(ids.filter((id) => !before.has(id)), ["c2"]);
    assert.deepEqual(await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: true }), ["c2"]);
  });
});

// 2026-10-30: ClickUp's chat-style history -- a newly sent email shows up as a chat item whose wrapper has
// the comment id as data-id (no data-comment-id), so a real send at 12:47 was reported "could not confirm".
const chatHistory = (items: [string, string][]) => `
  <div data-test="chat-room-items-list"><div data-testid="virtuoso-item-list">
    ${items.map(([id, subject], i) => `<div data-index="${i}"><div data-id="${id}"><div data-test="chat-item-presentational__container"><cu-comment-email-meta><div class="cu-comment-email-meta__subject">${subject}</div></cu-comment-email-meta><span data-id="att-${id}">report.pdf</span></div></div></div>`).join("")}
  </div></div>
  <div data-clickup-agent-composer-root="true">
    <input data-test="email-communicators__subject" value="" />
    <div class="ql-editor" contenteditable="true"></div>
    <button data-test="comment-bar__send-btn">Send</button>
  </div>`;

test("email verification: ClickUp's chat-style history -- a NEW chat item with the subject confirms the send", async () => {
  await withPage(chatHistory([["c1", "Older update"]]), async (page) => {
    const before = new Set(await page.evaluate(allPostedEntryIds));
    assert.deepEqual([...before], ["c1"], "only the chat item wrapper counts, not data-id inside it");
    await page.evaluate((subject) => {
      const doc = (globalThis as any).document;
      const item = doc.createElement("div");
      item.innerHTML = `<div data-id="c2"><div data-test="chat-item-presentational__container"><div class="cu-comment-email-meta__subject"></div></div></div>`;
      item.querySelector(".cu-comment-email-meta__subject").textContent = subject;
      doc.querySelector('[data-testid="virtuoso-item-list"]').appendChild(item);
    }, SUBJECT);
    const ids = await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: false });
    assert.deepEqual(ids, ["c2"]);
    assert.equal(ids.some((id) => !before.has(id)), true);
    assert.deepEqual(await page.evaluate(postedEntryIdsWithSubject, { subject: SUBJECT, exact: true }), ["c2"], "and a retry's duplicate guard sees it");
  });
});
