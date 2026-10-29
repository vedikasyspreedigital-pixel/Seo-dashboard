import { AgentError, navigate, pause, run, sleep, tabUrl, waitFor, waitForHuman, waitForLoad, waitForSignIn } from "../lib/browser.js";

// Semrush and Ubersuggest exports through seotooladda, in THIS Chrome (where
// someone is signed in -- seotooladda's login has a reCAPTCHA, so the agent
// never logs in). Mapped from the user's recording (2026-10-21):
//   seotooladda.com/user/in/access_<tool>.php -> "Go" (input#redirect) ->
//   smr.seotooladda.com (Semrush) / ub.seotooladda.com (Ubersuggest) ->
//   the tool's organic-keywords page for the domain + country -> Export.
// The export is captured from the page (both tools build the file in the
// browser), so nothing piles up in Downloads.

// Country codes per tool for the page's locations (Semrush databases; Ubersuggest
// uses Google's location IDs).
const SEMRUSH_DB = { au: "au", us: "us", uk: "uk", ca: "ca", nz: "nz", in: "in", ae: "ae", sa: "sa", qa: "qa", sg: "sg" };
const UBERSUGGEST_LOC = { au: 2036, us: 2840, uk: 2826, ca: 2124, nz: 2554, in: 2356, ae: 2784, sa: 2682, qa: 2634, sg: 2702 };

/**
 * Is the tab on seotooladda's REAL sign-in form? Not just "login" in the address (2026-10-29): Ubersuggest came
 * through in the same run while Semrush and WooRank said "signed out" -- the address "Go" passes through on the
 * way to a tool can contain "login" too. A sign-in form has a password box.
 */
async function onSeotooladdaSignIn(tabId) {
  let url;
  try {
    url = new URL(await tabUrl(tabId));
  } catch {
    return false;
  }
  if (!((url.hostname === "seotooladda.com" || url.hostname === "www.seotooladda.com") && /login/i.test(url.pathname))) return false;
  await waitForLoad(tabId, 15_000);
  // Still there once loaded, and showing a password box.
  if (!/login/i.test(new URL(await tabUrl(tabId)).pathname)) return false;
  return !!(await run(tabId, () => !!document.querySelector('input[type="password"]')).catch(() => false));
}

async function assertSignedIn(tabId) {
  if (await onSeotooladdaSignIn(tabId)) {
    throw new AgentError("SESSION_EXPIRED", "seotooladda is signed out in the office Chrome. Sign in to seotooladda in that browser (its login has a captcha, so a person must do it).");
  }
}

// ---- in-page helpers ----

/**
 * In-page: a full mouse press -> release -> click on an element. Some menus (Ubersuggest's
 * Radix dropdowns) open on the PRESS, so a bare element.click() does nothing (seen 2026-10-21).
 * Defined inline in each helper below, because executeScript only ships the one function.
 */

function hasRedirectButton() {
  return !!document.querySelector("input#redirect, button#redirect");
}

function clickRedirectButton() {
  const b = document.querySelector("input#redirect, button#redirect");
  b?.click();
  return !!b;
}

/** Clicks the first visible button/menu item whose text is exactly one of `labels` (in order of preference). */
export function clickByText(labels) {
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", at));
  };
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const nodes = [...document.querySelectorAll('button, [role="menuitem"], [role="option"], a, span, div')].filter(visible);
  for (const label of labels) {
    const hit = nodes.find((e) => (e.textContent || "").trim() === label && ![...e.children].some((c) => (c.textContent || "").trim() === label));
    if (hit) {
      press(hit.closest('button, [role="menuitem"], [role="option"], a') || hit);
      return label;
    }
  }
  return null;
}

/**
 * Ubersuggest: the control that opens its export menu. Matches "export"/"csv"/"download" in the
 * button's text, aria-label or title (it may be an icon button). Returns what it clicked, or null.
 */
function clickExportTrigger() {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const label = (e) => `${(e.textContent || "").trim()} ${e.getAttribute("aria-label") || ""} ${e.getAttribute("title") || ""}`.trim();
  const candidates = [...document.querySelectorAll('button, [role="button"], a')].filter(visible).filter((e) => /export|csv|download/i.test(label(e)));
  const best = candidates.find((e) => /^export$/i.test((e.textContent || "").trim())) || candidates[0];
  if (!best) return null;
  const r = best.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  best.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  best.dispatchEvent(new MouseEvent("mousedown", at));
  best.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  best.dispatchEvent(new MouseEvent("mouseup", at));
  best.dispatchEvent(new MouseEvent("click", at));
  return label(best).slice(0, 60) || "(icon)";
}

/** For error messages: the labels of visible buttons, so a failed step says what WAS on the page. */
function visibleButtonLabels() {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  return [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
    .filter(visible)
    .map((e) => `${(e.textContent || "").trim()}${e.getAttribute("aria-label") ? ` [${e.getAttribute("aria-label")}]` : ""}`.replace(/\s+/g, " ").slice(0, 40))
    .filter(Boolean)
    .slice(0, 40)
    .join(" | ");
}

/** MAIN world: keep a copy of the next file the page builds (URL.createObjectURL). */
export function installExportCapture() {
  window.__serpConsoleExport = null;
  if (!window.__serpConsoleCapture) {
    window.__serpConsoleCapture = true;
    const original = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      if (obj instanceof Blob && obj.size > 0) window.__serpConsoleExport = obj;
      return original.call(URL, obj);
    };
  }
  return true;
}

/** MAIN world: the captured file as { base64, type }, once it exists. */
export function readCapturedExport() {
  const blob = window.__serpConsoleExport;
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: String(reader.result).split(",")[1] || "", type: blob.type || "" });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// ---- shared steps ----

const accessPage = (tool) => `https://seotooladda.com/user/in/access_${tool}.php`;
const TOOL_NAMES = { semrush: "Semrush", ubersuggest: "Ubersuggest", woorank: "WooRank" };

/**
 * A tool opened through seotooladda's "Go" in the last 30 minutes is reused directly (2026-10-29): every report
 * used to go through the access page again -- ~10 times a run -- and seotooladda kept signing the account out.
 */
const TOOL_REUSE_MS = 30 * 60 * 1000;
// Semrush only: it's opened ~5 times a run (keywords, 3 competitors, Site Audit). WooRank's pages carry a key
// from the "Go" link (?api_key=...), and WooRank / Ubersuggest are opened once a run anyway.
const REUSABLE_TOOLS = new Set(["semrush"]);

/** In-page: a sign-in form or an "expired / access denied" notice instead of the tool. */
function toolSessionEnded() {
  const text = (document.body?.innerText ?? "").slice(0, 3000);
  return !!document.querySelector('input[type="password"]') || /session (has )?expired|access denied|please (log|sign) ?in|log ?in again/i.test(text);
}

/** The tool's own site, if its session from an earlier report still works (else null -- go through seotooladda). */
async function reuseTool(ctx, tool, toolHost) {
  if (!REUSABLE_TOOLS.has(tool)) return null;
  const { toolOpenedAt = {} } = await chrome.storage.local.get("toolOpenedAt");
  if (!(Date.now() - (toolOpenedAt[tool] ?? 0) < TOOL_REUSE_MS)) return null;
  await ctx.progress(`Opening ${TOOL_NAMES[tool] ?? tool} (still open from the last report)`);
  const tabId = await ctx.openTab(`https://${toolHost}/`);
  await waitForHuman(tabId, ctx, TOOL_NAMES[tool] ?? tool);
  const url = new URL(await tabUrl(tabId));
  if (url.hostname === toolHost && !(await run(tabId, toolSessionEnded).catch(() => true))) return tabId;
  // The tool's session has ended: the usual way, in the same window.
  await navigate(tabId, accessPage(tool));
  return { fallBackIn: tabId };
}

/**
 * After "Go": the tab of the job window that's on the tool's site (this one or a new one, made the active tab),
 * "signin" if this tab went to seotooladda's sign-in page instead, or null after `timeoutMs`.
 */
async function toolTabAfterGo(tabId, toolHost, timeoutMs) {
  const { windowId } = await chrome.tabs.get(tabId);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tabs = await chrome.tabs.query({ windowId });
    const host = (t) => {
      try {
        return new URL(t.pendingUrl || t.url || "").hostname;
      } catch {
        return "";
      }
    };
    // The newest tab on the tool's site.
    const tool = tabs.filter((t) => host(t) === toolHost).sort((a, b) => b.id - a.id)[0];
    if (tool) {
      await chrome.tabs.update(tool.id, { active: true }).catch(() => {});
      await waitForLoad(tool.id);
      return tool.id;
    }
    const here = tabs.find((t) => t.id === tabId);
    // Only a real sign-in form -- "Go" passes through addresses with "login" in them on its way to the tool.
    if (here && here.status === "complete" && (await onSeotooladdaSignIn(tabId))) return "signin";
    await sleep(1000);
  }
  return null;
}

/** seotooladda's own Access page -> "Go" -> the tool's site. Returns the tab. */
export async function openTool(ctx, tool, toolHost) {
  const reused = await reuseTool(ctx, tool, toolHost);
  if (typeof reused === "number") return reused;
  let tabId;
  if (reused) {
    tabId = reused.fallBackIn;
  } else {
    await ctx.progress("Opening seotooladda");
    tabId = await ctx.openTab(accessPage(tool));
  }
  await waitForHuman(tabId, ctx, "seotooladda");
  // Signed out -- on the access page, or only after "Go" (seen 2026-10-29 with WooRank: Semrush's own session
  // still worked while seotooladda's had ended) -- a person signs in in this window and the report carries on.
  const signIn = { where: "seotooladda", signedOut: onSeotooladdaSignIn, reopenUrl: accessPage(tool) };
  let arrived = false;
  for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
    await waitForSignIn(tabId, ctx, signIn);
    if (!(await waitFor(tabId, hasRedirectButton, [], 30_000))) {
      if (await waitForSignIn(tabId, ctx, signIn)) continue;
      throw new AgentError("FAILED", `seotooladda's ${tool} access page has no "Go" button -- is the ${tool} subscription active?`);
    }
    await pause();
    await ctx.progress(`Opening ${TOOL_NAMES[tool] ?? tool}`);
    await run(tabId, clickRedirectButton);
    // The tool's site -- in this tab, or in a NEW tab ("Go" opened WooRank in another tab on 2026-10-29 while the
    // agent kept watching the first one and wrongly said "signed out") -- or seotooladda's sign-in page, which
    // means: wait for a person, then "Go" again.
    const landed = await toolTabAfterGo(tabId, toolHost, 60_000);
    if (landed === "signin") continue;
    if (typeof landed === "number") {
      tabId = landed;
      arrived = true;
    }
    if (!arrived) break;
  }
  await waitForHuman(tabId, ctx, tool);
  await assertSignedIn(tabId);
  if (!arrived) throw new AgentError("FAILED", `${tool} didn't open from seotooladda.`);
  const { toolOpenedAt = {} } = await chrome.storage.local.get("toolOpenedAt");
  await chrome.storage.local.set({ toolOpenedAt: { ...toolOpenedAt, [tool]: Date.now() } });
  await pause();
  return tabId;
}

/** Captures what the page exports after `clickExport` runs. */
async function captureExport(tabId, clickExport) {
  await run(tabId, installExportCapture, [], "MAIN");
  await clickExport();
  const file = await waitFor(tabId, readCapturedExport, [], 120_000, 1000, "MAIN");
  if (!file?.base64) throw new AgentError("TIMEOUT", "The export file didn't arrive within 2 minutes.");
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // .xlsx
  const isOldXls = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if (isOldXls) throw new AgentError("FAILED", "The tool exported an old .xls file, which can't be read -- choose CSV.");
  return { bytes, ext: isZip ? "xlsx" : "csv" };
}

// ---- Semrush: Organic Research > Positions > Export ----

/**
 * In-page: Semrush's Export button above the positions table. In a narrow window Semrush shows it as an icon
 * only (2026-10-28, "Save keywords" -> "Save" too), so its aria-label / title count as well as its text.
 * "Export to PDF" (the page header's) is a different button. press=true also clicks it.
 */
function semrushExportButton(press) {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const isExport = (s) => /^export$/i.test((s || "").trim());
  const button = [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true")
    .find((b) => isExport(b.textContent) || isExport(b.getAttribute("aria-label")) || isExport(b.getAttribute("title")) || isExport(b.getAttribute("data-test")));
  if (!button) return false;
  if (press) {
    const r = button.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    button.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mousedown", at));
    button.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mouseup", at));
    button.dispatchEvent(new MouseEvent("click", at));
  }
  return true;
}

export async function runSemrush(task, ctx) {
  const db = SEMRUSH_DB[(task.location || "au").toLowerCase()] || "au";
  const tabId = await openTool(ctx, "semrush", "smr.seotooladda.com");

  await ctx.progress(`Organic positions (${db.toUpperCase()})`);
  const url = new URL("https://smr.seotooladda.com/analytics/organic/positions/");
  url.searchParams.set("db", db);
  url.searchParams.set("q", task.domain);
  url.searchParams.set("searchType", "domain");
  await navigate(tabId, url.toString());
  await waitForHuman(tabId, ctx, "Semrush");
  const ready = await waitFor(tabId, semrushExportButton, [false], 60_000);
  if (!ready) {
    const seen = await run(tabId, visibleButtonLabels).catch(() => "");
    throw new AgentError("TIMEOUT", `Semrush's Organic Positions report didn't load (no Export button). Buttons on the page: ${seen}`.slice(0, 480));
  }
  await pause(2000, 4000);

  await ctx.progress("Exporting from Semrush");
  const { bytes, ext } = await captureExport(tabId, async () => {
    await run(tabId, semrushExportButton, [true]);
    // The Export menu: CSV if offered, else Excel (.xlsx) -- both are read the same way.
    const chosen = await waitFor(tabId, clickByText, [["CSV", "Excel"]], 20_000);
    if (!chosen) throw new AgentError("FAILED", "Semrush's Export menu didn't open.");
  });
  return { bytes, fileName: `${task.domain}-semrush-positions-${db}.${ext}` };
}

// ---- Semrush: Organic Research > Competitors (the list Domain Overview shows as "Main Organic Competitors") ----

/** In-page: Organic Research > Competitors table rows -> [{ domain, numbers }], in the table's order. */
function readCompetitorTable() {
  const isDomain = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
  const rows = [];
  const seen = new Set();
  for (const row of document.querySelectorAll('[role="row"], tr, [data-ui-name="DataTable.Row"]')) {
    const cell = [...row.querySelectorAll("a, span, div")].find((e) => e.children.length === 0 && isDomain((e.textContent || "").trim()));
    if (!cell) continue;
    const domain = (cell.textContent || "").trim().toLowerCase();
    if (seen.has(domain)) continue;
    seen.add(domain);
    // Cell by cell: the row's text runs the numbers together ("45" + "5.2K" -> "455.2K").
    const cells = [...row.querySelectorAll('[role="cell"], [role="gridcell"], td, [data-ui-name*="Cell"]')].filter((c) => !c.querySelector('[role="cell"], td'));
    const numbers = cells
      .map((c) => (c.textContent || "").trim())
      .filter((t) => /^\d[\d,.]*[KMB]?$/i.test(t))
      .slice(0, 3);
    rows.push({ domain, numbers });
    if (rows.length >= 10) break; // only the top few are offered
  }
  // Wait until the table has filled in (a few rows), not just a header.
  return rows.length >= 3 ? rows : null;
}

export async function runSemrushCompetitors(task, ctx) {
  const db = SEMRUSH_DB[(task.location || "au").toLowerCase()] || "au";
  const tabId = await openTool(ctx, "semrush", "smr.seotooladda.com");

  // Organic Research > Competitors: the same list as Domain Overview's "Main Organic Competitors"
  // (sorted by competition level), as a plain table -- the Overview's card moved in Semrush's newer layout.
  await ctx.progress(`Organic Research > Competitors (${db.toUpperCase()})`);
  const url = new URL("https://smr.seotooladda.com/analytics/organic/competitors/");
  url.searchParams.set("db", db);
  url.searchParams.set("q", task.domain);
  url.searchParams.set("searchType", "domain");
  await navigate(tabId, url.toString());
  await waitForHuman(tabId, ctx, "Semrush");
  const rows = await waitFor(tabId, readCompetitorTable, [], 90_000, 1500);
  if (!rows) {
    const headings = await run(tabId, () =>
      [...document.querySelectorAll("h1, h2, h3, h4, [data-ui-name*='Title']")].map((e) => (e.textContent || "").trim().slice(0, 40)).filter(Boolean).slice(0, 25).join(" | "),
    ).catch(() => "");
    throw new AgentError("FAILED", `Semrush's Organic Competitors table didn't load. Headings seen: ${headings}`.slice(0, 480));
  }
  const own = task.domain.replace(/^www\./, "").toLowerCase();
  const csv = ["Domain,Com. Level rank,Com. Keywords,SE Keywords"]
    .concat(
      rows
        .filter((r) => r.domain.replace(/^www\./, "") !== own)
        .map((r, i) => [r.domain, i + 1, (r.numbers[0] || "").replace(/,/g, ""), (r.numbers[1] || "").replace(/,/g, "")].join(",")),
    )
    .join("\n");
  return { bytes: new TextEncoder().encode(csv), fileName: `${task.domain}-semrush-competitors-${db}.csv` };
}

// ---- Ubersuggest: Competitive research > Keyword Coverage > Export All to CSV ----

export async function runUbersuggest(task, ctx) {
  const code = (task.location || "au").toLowerCase();
  const locId = UBERSUGGEST_LOC[code] || 2036;
  const tabId = await openTool(ctx, "ubersuggest", "ub.seotooladda.com");

  await ctx.progress(`Keyword coverage (${code.toUpperCase()})`);
  const url = new URL("https://ub.seotooladda.com/en/competitive-research/keyword-coverage");
  url.searchParams.set("domain", task.domain);
  url.searchParams.set("mode", "domain");
  url.searchParams.set("locId", String(locId));
  url.searchParams.set("lang", "en");
  await navigate(tabId, url.toString());
  await waitForHuman(tabId, ctx, "Ubersuggest");
  const ready = await waitFor(tabId, () => /export/i.test(document.body?.innerText ?? ""), [], 60_000);
  if (!ready) throw new AgentError("TIMEOUT", "Ubersuggest's Keyword Coverage report didn't load.");
  await pause(2000, 4000);

  await ctx.progress("Exporting from Ubersuggest");
  const { bytes, ext } = await captureExport(tabId, async () => {
    // The export menu's trigger, then "Export All to CSV" (seen in the recording).
    const direct = await run(tabId, clickByText, [["Export All to CSV"]]);
    if (!direct) {
      const trigger = await waitFor(tabId, clickExportTrigger, [], 20_000);
      const chosen = trigger ? await waitFor(tabId, clickByText, [["Export All to CSV", "Export to CSV", "Export CSV"]], 20_000) : null;
      if (!chosen) {
        const seen = await run(tabId, visibleButtonLabels).catch(() => "");
        throw new AgentError(
          "FAILED",
          `Ubersuggest's "Export All to CSV" option didn't appear (${trigger ? `clicked "${trigger}"` : "no export button found"}). Buttons on the page: ${seen}`.slice(0, 480),
        );
      }
    }
  });
  return { bytes, fileName: `${task.domain}-ubersuggest-keywords-${code}.${ext}` };
}
