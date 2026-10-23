import { AgentError, navigate, pause, run, sleep, tabUrl, waitFor, waitForLoad } from "../lib/browser.js";
import { openTool } from "./seotooladda.js";

// WooRank website review through seotooladda, in THIS Chrome (user's plan,
// 2026-10-22; the team's own report came from wr.seotooladda.com):
//   seotooladda access page -> wr.seotooladda.com/en/create/review -> type the
//   domain -> Create Review -> /en/www/<domain> -> Refresh (about a minute; the
//   date/time and score update) -> Download PDF (WooRank's own PDF -- the
//   user's choice over printing the page). Steps from the user's screenshots.

const HOST = "wr.seotooladda.com";

// ---- in-page helpers (each is shipped alone by executeScript) ----

/** Full mouse press on the first visible button/link whose text matches `pattern` (source string). */
function pressByText(pattern) {
  const re = new RegExp(pattern, "i");
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const el = [...document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')]
    .filter(visible)
    .find((e) => re.test((e.textContent || e.value || "").replace(/\s+/g, " ").trim()));
  if (!el || el.disabled) return null;
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
  return (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Types `domain` into the "Create a Review" box (so the page's own code sees the change). */
function fillReviewDomain(domain) {
  const input = [...document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])')].find((e) => e.offsetWidth || e.offsetHeight);
  if (!input) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, domain);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value === domain;
}

/**
 * The "Create Review" BUTTON beside the box -- not the "Create Review" link at the top of the page,
 * which only reloads it and empties the box (seen 2026-10-22).
 */
function submitCreateReview(how) {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const input = [...document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])')].find(visible);
  const isCreate = (e) => /^create review$/i.test((e.textContent || e.value || "").replace(/\s+/g, " ").trim());
  const inForm = input?.form ? [...input.form.querySelectorAll('button, input[type="submit"]')].filter(visible).find(isCreate) : null;
  // Not the nav link at the top: the matching control nearest below/beside the box.
  const near = (e) => (input ? Math.abs(e.getBoundingClientRect().top - input.getBoundingClientRect().top) : 0);
  const others = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')].filter(visible).filter(isCreate).sort((a, b) => near(a) - near(b));
  const button = inForm || others[0];
  if (!button) return false;
  if (how === "submit") {
    if (!input?.form) return false;
    input.form.requestSubmit ? input.form.requestSubmit(button.form === input.form ? button : undefined) : input.form.submit();
    return true;
  }
  if (how === "enter") {
    if (!input) return false;
    for (const t of ["keydown", "keypress", "keyup"]) input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    return true;
  }
  if (how === "click") {
    button.click();
    return true;
  }
  const r = button.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  button.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  button.dispatchEvent(new MouseEvent("mousedown", at));
  button.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  button.dispatchEvent(new MouseEvent("mouseup", at));
  button.dispatchEvent(new MouseEvent("click", at));
  return true;
}

/** For the error message: what the "Create Review" controls on the page actually are. */
function createButtonHtml() {
  return [...document.querySelectorAll("button, a, input[type=submit], [role=button]")]
    .filter((e) => /create review/i.test(e.textContent || e.value || ""))
    .map((e) => e.outerHTML.replace(/\s+/g, " ").slice(0, 160))
    .join(" || ");
}

/** The review's state: its score, the date it shows, and whether it's still being made. */
function reviewState() {
  const text = document.body?.innerText ?? "";
  const date = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}(?: \d{1,2}:\d{2} ?[AP]M)?/);
  const busy = /analy[sz]ing|in progress|please wait|generating|updating|crawling/i.test(text);
  const hasRefresh = [...document.querySelectorAll("button, a")].some((e) => /^refresh$/i.test((e.textContent || "").trim()));
  const hasPdf = [...document.querySelectorAll("button, a")].some((e) => /download\s*pdf/i.test((e.textContent || "").replace(/\s+/g, " ")));
  return { date: date?.[0] ?? null, busy, hasRefresh, hasPdf, snippet: text.replace(/\s+/g, " ").slice(0, 200) };
}

/** MAIN world: WooRank's "Download PDF" calls window.print() -- note the request instead of opening the dialog. */
function holdBackPrint() {
  window.__serpConsolePrint = false;
  window.print = () => {
    window.__serpConsolePrint = true;
  };
  return true;
}

/**
 * Saves the tab as an A4 PDF through Chrome's own print engine (DevTools protocol -- Chrome shows a
 * "started debugging this browser" bar while it runs). The footer has page numbers only: the page's
 * address carries seotooladda's access key, so it must not be printed on a client's report.
 */
async function printTabToPdf(tabId, title) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    throw new AgentError("FAILED", `Couldn't save WooRank's page as a PDF (${err?.message || err}). Is DevTools open on that tab?`);
  }
  try {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const { data } = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px;width:100%;padding:0 0.4in;color:#555;display:flex;justify-content:space-between"><span class="date"></span><span>${esc(title)}</span></div>`,
      footerTemplate: `<div style="font-size:8px;width:100%;padding:0 0.4in;color:#555;text-align:right"><span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
    });
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function errorText() {
  const m = (document.body?.innerText ?? "").match(/[^\n]*(something went wrong|error occurred|limit (?:reached|exceeded)|no credits|try again later)[^\n]*/i);
  return m ? m[0].trim().slice(0, 200) : null;
}

const todayLabel = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** The tab in the job window showing a WooRank review (/en/www/...), within `timeoutMs`. */
async function findReviewTab(windowId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tabs = await chrome.tabs.query({ windowId });
    const hit = tabs.filter((t) => (t.pendingUrl || t.url || "").includes(`${HOST}/en/www/`)).sort((a, b) => b.id - a.id)[0];
    if (hit) return hit.id;
    await sleep(1000);
  }
  return null;
}

// ---- the flow ----

export async function runWooRank(task, ctx) {
  const domain = task.domain.replace(/^www\./, "");
  let tabId = await openTool(ctx, "woorank", HOST);

  // "Create a Review": type the domain -> Create Review -> the review page (/en/www/<domain>?api_key=...).
  await ctx.progress(`Opening the WooRank review for ${domain}`);
  if (!/\/create\/review/.test(new URL(await tabUrl(tabId)).pathname)) await navigate(tabId, `https://${HOST}/en/create/review`);
  if (!(await waitFor(tabId, fillReviewDomain, [domain], 30_000))) throw new AgentError("FAILED", 'WooRank\'s "Create a Review" box didn\'t appear.');
  await pause(600, 1200);
  // The review opens in a NEW TAB (seen 2026-10-23: the create page stays as it was) -- press once, then
  // follow it there; only if no review appears anywhere, try submitting another way.
  const createTab = tabId;
  const { windowId } = await chrome.tabs.get(createTab);
  let reviewTab = null;
  for (const how of ["press", "submit", "click"]) {
    const done = await run(createTab, submitCreateReview, [how]);
    if (!done && how === "press") throw new AgentError("FAILED", 'Couldn\'t find WooRank\'s "Create Review" button.');
    if (done && (reviewTab = await findReviewTab(windowId, 30_000))) break;
  }
  if (!reviewTab) {
    const html = await run(createTab, createButtonHtml).catch(() => "?");
    throw new AgentError("FAILED", `WooRank's "Create Review" didn't open the review. Button: ${html}`.slice(0, 480));
  }
  tabId = reviewTab;
  await chrome.tabs.update(tabId, { active: true });
  await waitForLoad(tabId);
  const ready = await waitFor(tabId, () => {
    const s = (document.body?.innerText ?? "").replace(/\s+/g, " ");
    return /refresh/i.test(s) && /download pdf/i.test(s);
  }, [], 90_000);
  if (!ready) {
    const s = await run(tabId, reviewState).catch(() => null);
    throw new AgentError("FAILED", `WooRank's review page didn't open for ${domain}. Page shows: ${s?.snippet ?? "?"}`.slice(0, 480));
  }

  // Refresh -> a review made today (the team always refreshes first).
  const before = await run(tabId, reviewState);
  await ctx.progress(`Refreshing the WooRank review (was ${before.date ?? "no date"})`);
  if (!(await run(tabId, pressByText, ["^refresh$"]))) throw new AgentError("FAILED", 'Couldn\'t find WooRank\'s "Refresh" button.');
  await sleep(4000);
  // Done = nothing in progress, Download PDF back, and today's date -- a new date/time, or (a review
  // refreshed earlier the same minute shows the same one) still today's after a minute of waiting.
  const started = Date.now();
  const end = started + 6 * 60 * 1000;
  let fresh = null;
  let pressedAgain = false;
  while (Date.now() < end && !fresh) {
    const err = await run(tabId, errorText).catch(() => null);
    if (err) throw new AgentError("FAILED", `WooRank: "${err}"`);
    const s = await run(tabId, reviewState).catch(() => null);
    // Nothing happening 45s after the press (same date, nothing in progress): press Refresh once more.
    if (!pressedAgain && Date.now() - started > 45_000 && s && !s.busy && s.date === before.date) {
      pressedAgain = true;
      await ctx.progress(`Refresh didn't start (still ${s.date}) -- pressing Refresh again`);
      await run(tabId, pressByText, ["^refresh$"]);
      await sleep(4000);
      continue;
    }
    const today = s && !s.busy && s.hasPdf && s.date?.startsWith(todayLabel());
    if (today && (s.date !== before.date || Date.now() - started > 60_000)) fresh = s;
    else await sleep(3000);
  }
  if (!fresh) {
    const s = await run(tabId, reviewState).catch(() => null);
    throw new AgentError("TIMEOUT", `WooRank's refresh didn't finish within 6 minutes. Page shows: ${s?.snippet ?? "?"}`.slice(0, 480));
  }
  await ctx.progress(`Review ready (${fresh.date}) -- downloading WooRank's PDF`);
  await pause(1000, 2000);

  // "Download PDF" opens Chrome's PRINT dialog (seen 2026-10-23), which nothing can click. So: hold back
  // window.print, press Download PDF (WooRank lays the page out for print), then save the page as a PDF
  // ourselves -- the same file as "Save as PDF" in that dialog.
  await run(tabId, holdBackPrint, [], "MAIN");
  if (!(await run(tabId, pressByText, ["^download\\s*pdf$"]))) throw new AgentError("FAILED", 'Couldn\'t find WooRank\'s "Download PDF" button.');
  await waitFor(tabId, () => window.__serpConsolePrint === true, [], 20_000, 500, "MAIN");
  await sleep(2000);
  const file = await printTabToPdf(tabId, `WooRank review -- ${domain}`);
  const isPdf = file[0] === 0x25 && file[1] === 0x50 && file[2] === 0x44 && file[3] === 0x46; // %PDF
  if (!isPdf) throw new AgentError("FAILED", "WooRank returned a file that isn't a PDF.");
  return { bytes: file, fileName: `${domain}-woorank-audit.pdf` };
}
