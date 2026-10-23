import { AgentError, navigate, pause, run, tabUrl, waitFor, waitForHuman } from "../lib/browser.js";

// Ahrefs "Organic keywords" export through Flikover, in THIS Chrome -- the path
// mapped with the user (2026-10-16/19 recordings + screenshots):
//   flikover.com/user/in/ahrefs.php -> "Click here to access Ahrefs" (its link,
//   access2.php, lands on ahn.flikover.com) -> Organic keywords for the site +
//   country, no comparison -> the TABLE's Export (the chart above has its own)
//   -> "All N" rows + "CSV (UTF-16, best for Excel)" -> Export.
// The export is captured from the page itself (Ahrefs builds the file in the
// browser), so nothing piles up in Downloads, and its rows are checked
// against Ahrefs' "N keywords".

const ACCESS_PAGE = "https://flikover.com/user/in/ahrefs.php";
const SITE_EXPLORER = "https://ahn.flikover.com/site-explorer";

/** The page's Semrush-style codes -> Ahrefs (ISO) country codes. */
const ahrefsCountry = (location) => ((location || "au").toLowerCase() === "uk" ? "gb" : (location || "au").toLowerCase());

/** Fails with the right code if the tab is on a Flikover sign-in / error page instead of where we expect. */
async function assertSignedIn(tabId) {
  const url = new URL(await tabUrl(tabId));
  if (url.hostname.endsWith("flikover.com") && url.hostname !== "ahn.flikover.com") {
    if (url.pathname === "/user/in/ahrefs.php" || url.pathname === "/user/in/access2.php") return;
    if (/error/i.test(url.pathname)) {
      throw new AgentError("MULTIPLE_SESSIONS", 'Flikover said "Multiple Sessions Detected" in the office Chrome. Sign in to Flikover again there.');
    }
    if (/login/i.test(url.pathname)) throw new AgentError("SESSION_EXPIRED", "Flikover is signed out in the office Chrome. Sign in to Flikover in that browser.");
  }
}

// ---- in-page functions (run inside the Ahrefs tab) ----

function findAccessLink() {
  const el = [...document.querySelectorAll("a, button, span")].find((e) => (e.textContent || "").trim() === "Click here to access Ahrefs");
  const a = el?.closest("a");
  return a?.href && !a.href.startsWith("javascript:") ? a.href : el ? "CLICK" : null;
}

function clickAccessLink() {
  const el = [...document.querySelectorAll("a, button, span")].find((e) => (e.textContent || "").trim() === "Click here to access Ahrefs");
  (el?.closest("a") || el)?.click();
  return !!el;
}

/** The keyword TABLE's toolbar: "N keywords" ... Columns | API | Export. Returns N, or null if not there yet. */
function tableKeywordCount() {
  const label = [...document.querySelectorAll("div, span")].find((e) => /^[\d,]+ keywords$/.test((e.textContent || "").trim()) && e.children.length === 0);
  if (!label) return null;
  let bar = label.parentElement;
  for (let i = 0; i < 8 && bar; i++, bar = bar.parentElement) {
    const buttons = [...bar.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    if (buttons.includes("Columns") && buttons.includes("Export")) return Number(label.textContent.replace(/[^\d]/g, ""));
  }
  return null;
}

function clickTableExport() {
  const label = [...document.querySelectorAll("div, span")].find((e) => /^[\d,]+ keywords$/.test((e.textContent || "").trim()) && e.children.length === 0);
  let bar = label?.parentElement;
  for (let i = 0; i < 8 && bar; i++, bar = bar.parentElement) {
    const buttons = [...bar.querySelectorAll("button")];
    if (buttons.some((b) => (b.textContent || "").trim() === "Columns")) {
      const exp = buttons.find((b) => (b.textContent || "").trim() === "Export");
      if (exp) {
        exp.click();
        return true;
      }
    }
  }
  return false;
}

/** In the Export dialog: make sure "All N" + CSV UTF-16 are chosen (both are the defaults), then press its Export. */
function exportFromDialog() {
  const heading = [...document.querySelectorAll("div, span, label, p")].find((e) => (e.textContent || "").trim() === "Number of rows");
  if (!heading) return null; // not open yet -- waitFor() asks again
  let dialog = heading.parentElement;
  for (let i = 0; i < 10 && dialog; i++, dialog = dialog.parentElement) {
    const buttons = [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    if (buttons.includes("Cancel") && buttons.includes("Export")) break;
  }
  if (!dialog) return null;
  const radioFor = (test) =>
    [...dialog.querySelectorAll('input[type="radio"]')].find((r) => test((r.closest("label")?.textContent || r.parentElement?.textContent || "").trim()));
  for (const r of [radioFor((t) => /^All [\d,]+$/.test(t)), radioFor((t) => t.startsWith("CSV (UTF-16"))]) {
    if (r && !r.checked) r.click();
  }
  const exp = [...dialog.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Export");
  exp.click();
  return "clicked";
}

/** MAIN world: keep a copy of the next file the page builds (Ahrefs makes the CSV with URL.createObjectURL). */
function installExportCapture() {
  if (window.__serpConsoleCapture) return true;
  window.__serpConsoleCapture = true;
  window.__serpConsoleExport = null;
  const original = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    if (obj instanceof Blob && obj.size > 0) window.__serpConsoleExport = obj;
    return original.call(URL, obj);
  };
  return true;
}

/** MAIN world: the captured file as base64, once it exists. */
function readCapturedExport() {
  const blob = window.__serpConsoleExport;
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// ---- the flow ----

/** Data rows in an Ahrefs CSV (UTF-16 or UTF-8): non-empty lines minus the header. */
function countCsvRows(bytes) {
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder("utf-16le").decode(bytes.subarray(2)) : new TextDecoder().decode(bytes);
  return Math.max(0, text.split(/\r?\n/).filter((l) => l.trim() !== "").length - 1);
}

/**
 * @param {{ domain: string, location: string | null }} task
 * @param {{ progress: (step: string, needsHuman?: boolean) => Promise<void>, openTab: (url: string) => Promise<number> }} ctx
 * @returns {Promise<{ bytes: Uint8Array, fileName: string }>}
 */
export async function runAhrefs(task, ctx) {
  await ctx.progress("Opening Flikover");
  const tabId = await ctx.openTab(ACCESS_PAGE);
  await waitForHuman(tabId, ctx, "Flikover");
  await assertSignedIn(tabId);

  const access = await waitFor(tabId, findAccessLink, [], 30_000);
  if (!access) {
    await assertSignedIn(tabId);
    throw new AgentError("FAILED", 'Flikover\'s Ahrefs page has no "Click here to access Ahrefs" button -- is the Ahrefs subscription active?');
  }
  await pause();
  await ctx.progress("Opening Ahrefs");
  if (access === "CLICK") await run(tabId, clickAccessLink);
  else await navigate(tabId, access);
  const onAhrefs = await waitFor(tabId, () => location.hostname === "ahn.flikover.com", [], 60_000);
  await waitForHuman(tabId, ctx, "Ahrefs");
  await assertSignedIn(tabId);
  if (!onAhrefs) throw new AgentError("FAILED", "Ahrefs didn't open from Flikover's Access page.");
  await pause();

  const country = ahrefsCountry(task.location);
  await ctx.progress(`Organic keywords (${country.toUpperCase()})`);
  const url = new URL(`${SITE_EXPLORER}/organic-keywords`);
  url.searchParams.set("target", `${task.domain}/`);
  url.searchParams.set("mode", "subdomains");
  url.searchParams.set("country", country);
  // Today's keywords only -- otherwise Ahrefs may compare with last month and add LOST keywords (seen 2026-10-19).
  url.searchParams.set("compareDate", "dontCompare");
  await navigate(tabId, url.toString());
  await waitForHuman(tabId, ctx, "Ahrefs");
  await assertSignedIn(tabId);
  const expected = await waitFor(tabId, tableKeywordCount, [], 60_000);
  if (expected === null) throw new AgentError("TIMEOUT", "Ahrefs' Organic keywords table didn't load.");
  if (expected === 0) throw new AgentError("NO_DATA", `Ahrefs has 0 organic keywords for ${task.domain} in ${country.toUpperCase()}.`);
  await pause(2000, 4000); // let the table finish loading

  await ctx.progress(`Exporting ${expected} keywords`);
  await run(tabId, installExportCapture, [], "MAIN");
  if (!(await run(tabId, clickTableExport))) throw new AgentError("FAILED", "Couldn't find the keyword table's Export button.");
  const dialog = await waitFor(tabId, exportFromDialog, [], 20_000);
  if (dialog !== "clicked") throw new AgentError("TIMEOUT", "Ahrefs' Export dialog didn't open.");
  const base64 = await waitFor(tabId, readCapturedExport, [], 120_000, 1000, "MAIN");
  if (!base64) throw new AgentError("TIMEOUT", "Ahrefs didn't produce the CSV within 2 minutes.");

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const rows = countCsvRows(bytes);
  if (rows < expected) throw new AgentError("NO_DATA", `Ahrefs exported ${rows} of ${expected} keywords -- the export was cut short.`);
  return { bytes, fileName: `${task.domain}-organic-keywords-${country}.csv` };
}
