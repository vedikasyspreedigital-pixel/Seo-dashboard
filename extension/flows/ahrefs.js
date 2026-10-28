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

/**
 * The keyword TABLE is ready: returns its "N keywords", or null if not there yet. Found by position, as a
 * person sees it (2026-10-27: Flikover injects its own scripts into Ahrefs and the structure-based match
 * kept missing): the LAST "N keywords" label on the page (the table's -- the chart above has its own)
 * with an "Export" control on the SAME ROW (Columns · API · Export).
 */
function tableKeywordCount() {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const norm = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
  const labels = [...document.querySelectorAll("div, span, h2, h3, p")].filter((e) => visible(e) && /^[\d,]+ keywords$/i.test(norm(e)) && e.children.length <= 2);
  const label = labels.pop();
  if (!label) return null;
  const row = label.getBoundingClientRect();
  const exportOnRow = [...document.querySelectorAll('button, a, [role="button"]')].some((b) => {
    if (!visible(b) || (b.textContent || "").replace(/[^a-z]/gi, "").toLowerCase() !== "export") return false;
    const r = b.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - (row.top + row.height / 2)) < 30;
  });
  return exportOnRow ? Number(norm(label).replace(/[^\d]/g, "")) : null;
}

/** For error messages: the page path, any "… keywords"-style counts, and the visible buttons. */
function describePage() {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const counts = [...document.querySelectorAll("div, span, h1, h2, h3")]
    .filter((e) => visible(e) && e.children.length <= 2 && /^[\d,.]+\s*[KM]?\s+\w+/.test((e.textContent || "").trim()) && (e.textContent || "").length < 40)
    .map((e) => (e.textContent || "").trim())
    .slice(0, 8);
  const describe = (e) => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""}${e.getAttribute("aria-label") ? `[aria=${e.getAttribute("aria-label")}]` : ""}"${(e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
  // Anything that mentions "export" (text, aria-label, title, data attributes).
  const exportish = [...document.querySelectorAll("*")]
    .filter((e) => visible(e) && e.children.length <= 3)
    .filter((e) => /export/i.test(`${(e.textContent || "").slice(0, 40)} ${e.getAttribute("aria-label") || ""} ${e.getAttribute("title") || ""} ${e.getAttribute("data-testid") || ""}`))
    .map(describe)
    .slice(0, 12);
  // The clickable things in the last "N keywords" label's toolbar.
  const isCount = (e) => /^[\d,]+\s+keywords$/.test((e.textContent || "").trim());
  const label = [...document.querySelectorAll("div, span")].filter((e) => isCount(e) && ![...e.children].some(isCount)).pop();
  let bar = label?.parentElement;
  for (let i = 0; i < 4 && bar; i++) bar = bar.parentElement;
  const near = bar ? [...bar.querySelectorAll('button, a, [role="button"], [role="menuitem"]')].filter(visible).map(describe).slice(0, 15) : [];
  // The table label's exact characters, and per ancestor level what "export" texts it holds -- so a
  // mismatch (odd spaces, an Export that isn't where expected) shows in the error itself.
  const anyCount = [...document.querySelectorAll("div, span")].filter((e) => /^[\d,]+\s*keywords$/i.test((e.textContent || "").replace(/\s+/g, " ").trim()) && e.children.length <= 2).pop();
  const codes = anyCount ? [...(anyCount.textContent || "")].map((c) => c.charCodeAt(0)).join(",") : "none";
  const levels = [];
  for (let i = 1, el = anyCount?.parentElement; i <= 8 && el; i++, el = el.parentElement) {
    const ex = [...el.querySelectorAll("*")].filter((e) => /export/i.test(e.textContent || "") && e.children.length <= 3).map((e) => `${e.tagName.toLowerCase()}:${JSON.stringify((e.textContent || "").trim().slice(0, 12))}:${e.children.length}`);
    levels.push(`L${i}=${ex.slice(-2).join("+") || "-"}`);
  }
  // The position check's own view: where the table's label is, and where each Export control is.
  const norm = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
  const lab = [...document.querySelectorAll("div, span, h2, h3, p")].filter((e) => visible(e) && /^[\d,]+ keywords$/i.test(norm(e)) && e.children.length <= 2).pop();
  const lr = lab?.getBoundingClientRect();
  const exps = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter((b) => (b.textContent || "").replace(/[^a-z]/gi, "").toLowerCase() === "export")
    .map((b) => {
      const r = b.getBoundingClientRect();
      return `${b.tagName.toLowerCase()}@${Math.round(r.top)}${visible(b) ? "" : "(hidden)"}`;
    });
  const onRow = !!lr && [...document.querySelectorAll('button, a, [role="button"]')].some((b) => {
    if (!visible(b) || (b.textContent || "").replace(/[^a-z]/gi, "").toLowerCase() !== "export") return false;
    const r = b.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - (lr.top + lr.height / 2)) < 30;
  });
  return `[flow v6] export-on-row=${onRow} label@${lr ? Math.round(lr.top) : "none"} "${lab ? norm(lab) : ""}" exports: ${exps.join(" ") || "none"} | path ${location.pathname} | label chars: ${codes} | levels: ${levels.join(" ")} | counts: ${counts.join(" / ") || "none"} | near: ${near.slice(0, 8).join(" , ") || "none"}`;
}

function clickTableExport() {
  // Same rule as tableKeywordCount: the Export on the same row as the table's "N keywords".
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const norm = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
  // A full press (some controls only react to pointer events) on the clickable around the "Export" text.
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", at));
  };
  const label = [...document.querySelectorAll("div, span, h2, h3, p")].filter((e) => visible(e) && /^[\d,]+ keywords$/i.test(norm(e)) && e.children.length <= 2).pop();
  if (!label) return false;
  const row = label.getBoundingClientRect();
  const exp = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => {
    if (!visible(b) || (b.textContent || "").replace(/[^a-z]/gi, "").toLowerCase() !== "export") return false;
    const r = b.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - (row.top + row.height / 2)) < 30;
  });
  if (exp) {
    press(exp);
    return true;
  }
  return false;
}

/** In the Export dialog: make sure "All N" + CSV UTF-16 are chosen (both are the defaults), then press its Export. */
function exportFromDialog() {
  // Spaces normalised: Ahrefs uses non-breaking spaces in labels (seen 2026-10-27 in "78 keywords").
  const text = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
  const heading = [...document.querySelectorAll("div, span, label, p")].find((e) => text(e) === "Number of rows");
  if (!heading) return null; // not open yet -- waitFor() asks again
  // The dialog's controls may not be <button>s either -- match any element by its own text.
  // Letters only: the labels can carry invisible characters (seen 2026-10-27 on the table's "Export").
  const byText = (root, re) => [...root.querySelectorAll("*")].filter((e) => re.test((e.textContent || "").replace(/[^a-z]/gi, "")) && e.children.length <= 3).pop();
  let dialog = heading.parentElement;
  for (let i = 0; i < 10 && dialog; i++, dialog = dialog.parentElement) {
    if (byText(dialog, /^cancel$/i) && byText(dialog, /^export$/i)) break; // letters-only text, see byText
  }
  if (!dialog) return null;
  const radioFor = (test) =>
    [...dialog.querySelectorAll('input[type="radio"]')].find((r) => test((r.closest("label")?.textContent || r.parentElement?.textContent || "").replace(/\s+/g, " ").trim()));
  for (const r of [radioFor((t) => /^All [\d,]+$/.test(t)), radioFor((t) => t.startsWith("CSV (UTF-16"))]) {
    if (r && !r.checked) r.click();
  }
  const exp = byText(dialog, /^export$/i);
  (exp.closest('button, a, [role="button"]') || exp).click();
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
  const expected = await waitFor(tabId, tableKeywordCount, [], 90_000);
  if (expected === null) {
    // Say what the page DID show, so a changed Ahrefs layout can be fixed from the error alone.
    const seen = await run(tabId, describePage).catch(() => "?");
    throw new AgentError("TIMEOUT", `Ahrefs' Organic keywords table didn't load. Page shows: ${seen}`.slice(0, 900));
  }
  if (expected === 0) throw new AgentError("NO_DATA", `Ahrefs has 0 organic keywords for ${task.domain} in ${country.toUpperCase()}.`);
  await pause(2000, 4000); // let the table finish loading

  await ctx.progress(`Exporting ${expected} keywords`);
  await run(tabId, installExportCapture, [], "MAIN");
  if (!(await run(tabId, clickTableExport))) throw new AgentError("FAILED", "Couldn't find the keyword table's Export button.");
  const dialog = await waitFor(tabId, exportFromDialog, [], 20_000);
  if (dialog !== "clicked") {
    const seen = await run(tabId, describePage).catch(() => "?");
    throw new AgentError("TIMEOUT", `Ahrefs' Export dialog didn't open. Page shows: ${seen}`.slice(0, 900));
  }
  const base64 = await waitFor(tabId, readCapturedExport, [], 120_000, 1000, "MAIN");
  if (!base64) throw new AgentError("TIMEOUT", "Ahrefs didn't produce the CSV within 2 minutes.");

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const rows = countCsvRows(bytes);
  if (rows < expected) throw new AgentError("NO_DATA", `Ahrefs exported ${rows} of ${expected} keywords -- the export was cut short.`);
  return { bytes, fileName: `${task.domain}-organic-keywords-${country}.csv` };
}
