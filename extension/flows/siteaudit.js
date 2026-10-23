import { AgentError, navigate, pause, run, sleep, waitFor, waitForHuman } from "../lib/browser.js";
import { clickByText, installExportCapture, openTool, readCapturedExport } from "./seotooladda.js";

// Semrush Site Audit through seotooladda, in THIS Chrome. Mapped from the
// user's recording (2026-10-22):
//   Semrush -> /siteaudit/ (project list, SHARED with other seotooladda users)
//   -> reuse the domain's project, or "Create project" (Website + Name, where
//   Name allows only letters, numbers and periods) -> General settings:
//   Limit per audit 1,000 pages, Schedule "Once" (the default is weekly), no
//   email -> "Start audit" -> wait for the crawl -> Overview -> "PDF" ->
//   Report template "Site Audit: Full Report" -> "Download PDF".
// Semrush's PDF sometimes answers "Something went wrong" (seen 2026-10-22;
// the user says it usually works): retry once, then fall back to the
// "Site Audit: Overview" template, else stop with a clear message.

const SITE_AUDIT = "https://smr.seotooladda.com/siteaudit/";
const MAX_CRAWL_WAIT_MS = 45 * 60 * 1000;
const POLL_MS = 30 * 1000;

// ---- in-page helpers ----

/**
 * The campaign id of the project we just created: the link whose text is our project name, or else
 * the NEWEST project (highest id) on a row mentioning the domain -- we always create a fresh one, so
 * the newest is ours (the list may show the name differently from what was typed, seen 2026-10-22).
 */
function findCampaignId(name, domain) {
  const bare = (s) => s.toLowerCase().replace(/^www\./, "");
  let newest = null;
  for (const a of document.querySelectorAll('a[href*="/siteaudit/campaign/"]')) {
    const m = a.getAttribute("href").match(/\/siteaudit\/campaign\/(\d+)/);
    if (!m) continue;
    const text = (a.textContent || "").trim().toLowerCase();
    if (text === name.toLowerCase()) return m[1];
    const row = a.closest('[data-ui-name="Row"], tr, [role="row"]') || a.parentElement?.parentElement;
    if ((row?.textContent || text).toLowerCase().includes(bare(domain)) && (!newest || Number(m[1]) > Number(newest))) newest = m[1];
  }
  return newest;
}

/**
 * The domain's row in the project list. While a project is still crawling its name is plain text, not a
 * link (like "Set up" rows, seen 2026-10-22), so: { id } once it's a link (crawl done), else { text } of the row.
 */
function projectRow(domain) {
  const bare = domain.toLowerCase().replace(/^www\./, "");
  let newest = null;
  for (const a of document.querySelectorAll('a[href*="/siteaudit/campaign/"]')) {
    const m = a.getAttribute("href").match(/\/siteaudit\/campaign\/(\d+)/);
    const row = a.closest('[data-ui-name="Row"], tr, [role="row"]') || a.parentElement?.parentElement;
    if (m && (row?.textContent || a.textContent || "").toLowerCase().includes(bare) && (!newest || Number(m[1]) > Number(newest))) newest = m[1];
  }
  if (newest) return { id: newest };
  const rows = [...document.querySelectorAll('[data-ui-name="Row"], tr, [role="row"]')].filter((r) => (r.textContent || "").toLowerCase().includes(bare));
  if (rows.length) {
    const text = (rows[0].innerText || rows[0].textContent || "").replace(/\s+/g, " ").trim();
    // "Set up" = the project exists but its audit was never started.
    return { text: text.slice(0, 120), setUp: /\bSet up\b/.test(text) };
  }
  return null;
}

/** Presses the "Set up" button on the domain's row (a project whose audit was never started). */
function pressSetUp(domain) {
  const bare = domain.toLowerCase().replace(/^www\./, "");
  const row = [...document.querySelectorAll('[data-ui-name="Row"], tr, [role="row"]')].find((r) => (r.textContent || "").toLowerCase().includes(bare) && /\bSet up\b/.test(r.textContent || ""));
  const btn = row && [...row.querySelectorAll("button, [role='button'], span")].find((b) => (b.textContent || "").trim() === "Set up");
  const el = btn?.closest("button, [role='button']") || btn;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
  return true;
}

/** Still on "Preparing to crawl…" (or the audit wizard is still open)? */
function stillStarting() {
  return /Preparing to crawl/i.test(document.body?.innerText ?? "") || wizardOpenInline();
  function wizardOpenInline() {
    return /General settings/.test(document.body?.innerText ?? "") && !!document.querySelector('[data-name="pageLimit"]');
  }
}

/** Types into the list's "Project name or domain" search so the domain's row shows even on a long shared list. */
function searchProjects(domain) {
  const input = [...document.querySelectorAll("input")].find((i) => /project name or domain/i.test(i.placeholder || ""));
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, domain);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function listReady() {
  return [...document.querySelectorAll("button, span")].some((e) => (e.textContent || "").trim() === "Create project");
}

/** "Create project" dialog, step 1: the Website box. Returns true once filled. */
function fillWebsite(domain) {
  const site = document.querySelector("input#domain") || [...document.querySelectorAll("input")].find((i) => /domain or subdomain/i.test(i.placeholder || ""));
  if (!site) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  site.focus();
  setter.call(site, domain);
  site.dispatchEvent(new Event("input", { bubbles: true }));
  site.dispatchEvent(new Event("change", { bubbles: true }));
  site.blur();
  return true;
}

/**
 * Step 2: the Name box. It appears after Semrush has checked the website and Semrush fills it with the
 * domain itself (seen 2026-10-22) -- only fill it if it's empty. Returns "ok", "exists" (Semrush says a
 * project with this website already exists) or null (not there yet).
 */
function fillName(name) {
  if (/project with this website already exists/i.test(document.body?.innerText ?? "")) return "exists";
  const input = document.querySelector("input#name") || [...document.querySelectorAll("input")].find((i) => /business name|project name/i.test(i.placeholder || ""));
  if (!input) return null;
  if (input.value.trim()) return "ok";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, name);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  return "ok";
}

/** The schedule dropdown's visible options (for a progress note when "Once" isn't among them). */
function visibleOptions() {
  return [...document.querySelectorAll('[role="option"], [data-ui-name="Select.Option"], [data-ui-name="DropdownMenu.Item"]')]
    .map((o) => (o.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
}

/** The audit wizard's "General settings" is showing. */
function wizardOpen() {
  return /General settings/.test(document.body?.innerText ?? "") && !!document.querySelector('[data-name="pageLimit"]');
}

/** Is a "Site Audit is crawling" state showing on the overview page? */
function auditState() {
  const text = document.body?.innerText ?? "";
  if (/Preparing to crawl|is being crawled|Crawling in progress|Audit in progress/i.test(text)) return { state: "crawling", text: (text.match(/\d[\d,]* ?\/ ?[\d,]+/) || [""])[0] };
  // A finished audit's Overview has the PDF button and the "Crawled Pages" figure (seen 2026-10-22).
  const pdf = document.querySelector('[data-path="header.overview_report.pdf_button"]') || [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "PDF");
  const pages = (text.match(/Crawled Pages[\s\S]{0,20}?([\d,]+)/) || [])[1];
  if (pdf && pages) {
    const health = (text.match(/Site Health[\s\S]{0,60}?(\d{1,3})%/) || [])[1];
    return { state: "done", health, pages };
  }
  return null;
}

/** For progress messages when the state is unclear: what the page shows. */
function pageSummary() {
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
  const pdf = !!document.querySelector('[data-path="header.overview_report.pdf_button"]');
  return `${document.title.slice(0, 50)} | PDF button: ${pdf ? "yes" : "no"} | ${text.slice(0, 160)}`;
}

/** "Something went wrong" (or a limit message) inside the export dialog. */
function exportError() {
  const text = document.body?.innerText ?? "";
  const m = text.match(/Something went wrong[^\n]*|You have reached[^\n]*|limit[^\n]{0,60}reached[^\n]*|not enough[^\n]{0,40}(?:reports|credits)[^\n]*/i);
  return m ? m[0].slice(0, 160) : null;
}

/** Picks a "Report template" option in the export dialog. */
function chooseTemplate(label) {
  const trigger = [...document.querySelectorAll('[data-ui-name^="Select.Trigger"], button')].find((e) => /^Site Audit:/.test((e.textContent || "").trim()));
  if (!trigger) return null;
  // The trigger shows a truncated label, e.g. "Site Audit: Full Rep..."
  if ((trigger.textContent || "").includes(label.split(": ")[1].slice(0, 8))) return "already";
  const r = trigger.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + 5, clientY: r.top + 5 };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) trigger.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, { ...at, pointerType: "mouse", isPrimary: true }) : new MouseEvent(t, at));
  return "opened";
}

/** Full mouse press -> release -> click on the element matching `selector` (Semrush's buttons, like Ubersuggest's menus, ignore a bare .click()). */
function pressSelector(selector) {
  const target = document.querySelector(selector);
  const el = target?.closest('button, [role="button"], [data-ui-name="Button"]') || target;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
  return true;
}

/** Has Semrush started making the PDF? (spinner on the Download PDF card, its done tick, or the download notice) */
function downloadBegan() {
  const card = document.querySelector('[data-test="lo-download-pdf-button"]');
  const box = card?.closest('button, [role="button"], [data-ui-name="Button"]') || card;
  if (box?.querySelector('[data-ui-name="Spin"], [class*="spin" i], [aria-busy="true"]') || box?.getAttribute("aria-busy") === "true") return true;
  return /download will start automatically|Something went wrong/i.test(document.body?.innerText ?? "");
}

/** The "Your download will start automatically. If not, click here to download" link, once Semrush shows it. */
function downloadLinkHref() {
  const link = [...document.querySelectorAll("a")].find((a) => /click here to download/i.test(a.textContent || ""));
  return link?.href || null;
}

/** Fetch `url` from inside the page (its cookies, and blobs only the page can read) -> base64. Runs in the MAIN world. */
async function fetchInPage(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  } catch {
    return null;
  }
}

function closeErrorNotice() {
  document.querySelector('[data-ui-name="Notice.Close.InnerWrapper"]')?.closest("button, [role='button'], span")?.click();
}

// ---- shared step: the audit wizard's settings, then Start audit ----

async function configureAndStart(tabId, ctx) {
  await ctx.progress("Audit settings: 1,000 pages, run once");
  // Limit per audit -> 1,000
  await run(tabId, () => {
    const input = document.querySelector('[data-name="pageLimit"]');
    input?.click();
    input?.focus();
  });
  await waitFor(tabId, clickByText, [["1,000"]], 10_000);
  await pause(600, 1200);
  // Schedule -> once (the default is weekly, which would re-crawl every week on the shared account)
  await run(tabId, clickByText, [["Weekly, Every Monday", "Weekly, Every Tuesday", "Weekly, Every Wednesday", "Weekly, Every Thursday", "Weekly, Every Friday", "Weekly, Every Saturday", "Weekly, Every Sunday", "Daily"]]);
  const once = await waitFor(tabId, clickByText, [["Once", "Run once", "Do not repeat", "Never", "Don't repeat", "Manually"]], 8_000);
  if (!once) {
    const options = await run(tabId, visibleOptions).catch(() => "");
    await ctx.progress(`Couldn't set the schedule to Once -- left as Semrush's default. Options seen: ${options || "(dropdown didn't open)"}`);
    await run(tabId, () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  }
  // No "audit complete" email
  await run(tabId, () => {
    const box = document.querySelector('[data-path="wizard.general.send_email_checkbox"] input, input[data-path="wizard.general.send_email_checkbox"]');
    if (box && box.checked) box.click();
  });
  await pause(800, 1500);
  if (!(await run(tabId, clickByText, [["Start audit"]]))) throw new AgentError("FAILED", 'Couldn\'t find "Start audit".');
  // Stay on the page until Semrush has actually started the crawl: leaving during
  // "Preparing to crawl…" left projects at "Set up", never crawled (seen 2026-10-22).
  await ctx.progress("Starting the audit (Preparing to crawl…)");
  const end = Date.now() + 5 * 60 * 1000;
  await sleep(3000);
  while (Date.now() < end && (await run(tabId, stillStarting).catch(() => false))) await sleep(3000);
  if (Date.now() >= end) throw new AgentError("TIMEOUT", 'Semrush stayed on "Preparing to crawl…" for 5 minutes.');
  await pause(2000, 3000);
}

// ---- the flow ----

/**
 * @returns {Promise<{ bytes: Uint8Array, fileName: string }>}
 */
export async function runSiteAudit(task, ctx) {
  const domain = task.domain.startsWith("www.") ? task.domain : `www.${task.domain}`;
  // A NEW project each time (user's rule, 2026-10-22), named just the domain -- the same name Semrush
  // fills in itself and a person uses (letters, numbers and periods only).
  const name = domain.replace(/[^A-Za-z0-9.]/g, "");
  const tabId = await openTool(ctx, "semrush", "smr.seotooladda.com");

  await ctx.progress("Opening Site Audit");
  await navigate(tabId, SITE_AUDIT);
  await waitForHuman(tabId, ctx, "Semrush");
  if (!(await waitFor(tabId, listReady, [], 60_000))) throw new AgentError("TIMEOUT", "Semrush Site Audit didn't load.");
  await pause();

  let campaignId = null;
  // A project left at "Set up" (created, audit never started) is finished off instead of creating another.
  await run(tabId, searchProjects, [task.domain]);
  await sleep(2500);
  const existing = await waitFor(tabId, projectRow, [task.domain], 6_000);
  if (existing?.id) {
    // A finished project for this website already exists (Semrush allows only one per website): use it.
    campaignId = existing.id;
    await ctx.progress("Using the finished Site Audit project that already exists");
  } else if (existing?.setUp) {
    await ctx.progress('Found the project at "Set up" -- starting its audit');
    await run(tabId, pressSetUp, [task.domain]);
    if (!(await waitFor(tabId, wizardOpen, [], 30_000))) throw new AgentError("FAILED", 'Semrush didn\'t open the audit settings from "Set up".');
    await configureAndStart(tabId, ctx);
  } else {
    await ctx.progress(`Creating the Site Audit project "${name}"`);
    if (!(await run(tabId, pressSelector, ["#cpmButton"]))) await run(tabId, clickByText, [["Create project"]]);
    let site = await waitFor(tabId, fillWebsite, [domain], 10_000);
    if (!site) {
      // Second try with a plain click, in case this button reacts to that instead.
      await run(tabId, () => (document.querySelector("#cpmButton")?.closest("button") || document.querySelector("#cpmButton"))?.click());
      site = await waitFor(tabId, fillWebsite, [domain], 10_000);
    }
    if (!site) {
      const seen = await run(tabId, pageSummary).catch(() => "?");
      throw new AgentError("FAILED", `Semrush's "Create project" dialog didn't open. Page shows: ${seen}`.slice(0, 480));
    }
    // The Name box appears once Semrush has checked the website (and Semrush fills it in).
    const named = await waitFor(tabId, fillName, [name], 20_000);
    if (named === "exists") {
      throw new AgentError("FAILED", `Semrush says a Site Audit project for ${domain} already exists (only one per website is allowed). Delete it in Semrush's Site Audit list, then run this again.`);
    }
    if (named !== "ok") {
      const seen = await run(tabId, pageSummary).catch(() => "?");
      throw new AgentError("FAILED", `Semrush didn't accept the website ${domain} (no Name box appeared). Page shows: ${seen}`.slice(0, 480));
    }
    await pause(1500, 2500);
    // The first click on Create sometimes only validates (seen in the recording) -- press until the wizard opens.
    for (let i = 0; i < 3 && !(await run(tabId, wizardOpen)); i++) {
      await run(tabId, clickByText, [["Create"]]);
      await sleep(3000);
    }
    if (!(await waitFor(tabId, wizardOpen, [], 30_000))) {
      const msg = await run(tabId, exportError).catch(() => null);
      throw new AgentError("FAILED", `Semrush didn't open the audit settings after creating the project${msg ? ` (${msg})` : ""} -- the shared account may have hit its project limit.`);
    }
    await configureAndStart(tabId, ctx);
  }

  {
    // Watch the project list: our row becomes a link (with the project id) once the first crawl is done.
    const createdAt = Date.now();
    while (!campaignId && Date.now() - createdAt < MAX_CRAWL_WAIT_MS) {
      await navigate(tabId, SITE_AUDIT);
      await waitForHuman(tabId, ctx, "Semrush");
      await waitFor(tabId, listReady, [], 60_000);
      await run(tabId, searchProjects, [task.domain]);
      await sleep(3000);
      const row = await waitFor(tabId, projectRow, [task.domain], 15_000);
      if (row?.id) {
        campaignId = row.id;
        break;
      }
      const mins = Math.round((Date.now() - createdAt) / 60000);
      await ctx.progress(`Semrush is crawling the site -- ${mins} min so far${row?.text ? ` (${row.text})` : " (project not in the list yet)"}`);
      await sleep(POLL_MS);
    }
    if (!campaignId) throw new AgentError("TIMEOUT", "The Site Audit crawl didn't finish within 45 minutes. It keeps running in Semrush -- try the export again later.");
  }

  // Wait for the crawl to finish (Semrush gives no typical time; 54 pages took ~6 min).
  const overview = `https://smr.seotooladda.com/siteaudit/campaign/${campaignId}/review/overview`;
  const started = Date.now();
  let summary = null;
  while (Date.now() - started < MAX_CRAWL_WAIT_MS) {
    await navigate(tabId, overview);
    await waitForHuman(tabId, ctx, "Semrush");
    const state = await waitFor(tabId, auditState, [], 45_000);
    if (state?.state === "done") {
      summary = state;
      break;
    }
    const mins = Math.round((Date.now() - started) / 60000);
    if (state?.state === "crawling") await ctx.progress(`Semrush is crawling the site${state.text ? ` (${state.text} pages)` : ""} -- ${mins} min so far`);
    else await ctx.progress(`Waiting for the audit (${mins} min) -- page shows: ${await run(tabId, pageSummary).catch(() => "?")}`);
    await sleep(POLL_MS);
  }
  if (!summary) throw new AgentError("TIMEOUT", "The Site Audit crawl didn't finish within 45 minutes. It keeps running in Semrush -- try the export again later.");
  await ctx.progress(`Crawl done: Site Health ${summary.health ?? "?"}%, ${summary.pages ?? "?"} pages`);
  await pause();

  // Export: Full Report -> retry once -> Overview template.
  const attempts = [
    ["Site Audit: Full Report", "full"],
    ["Site Audit: Full Report", "full"],
    ["Site Audit: Overview", "overview"],
  ];
  for (const [template, kind] of attempts) {
    await ctx.progress(`Downloading the PDF (${template.replace("Site Audit: ", "")})`);
    await run(tabId, closeErrorNotice).catch(() => {});
    const dialogOpen = await run(tabId, () => /Export settings/.test(document.body?.innerText ?? ""));
    if (!dialogOpen) {
      // A freshly finished audit may show a popup or tour over the page first -- close it and retry.
      let opened = false;
      for (let i = 0; i < 3 && !opened; i++) {
        await run(tabId, () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          document.querySelector('[data-ui-name="Modal.Close"], [data-ui-name="Modal.Close.InnerWrapper"]')?.closest("button, [role='button'], span")?.click();
        });
        await sleep(1500);
        if (!(await run(tabId, pressSelector, ['[data-path="header.overview_report.pdf_button"]']))) await run(tabId, clickByText, [["PDF"]]);
        opened = !!(await waitFor(tabId, () => /Export settings|Report template/.test(document.body?.innerText ?? ""), [], 12_000));
      }
      if (!opened) {
        const seen = await run(tabId, pageSummary).catch(() => "?");
        throw new AgentError("FAILED", `Semrush's PDF dialog didn't open. Page shows: ${seen}`.slice(0, 480));
      }
    }
    if ((await run(tabId, chooseTemplate, [template])) === "opened") {
      await waitFor(tabId, clickByText, [[template]], 10_000);
      await pause(600, 1200);
    }
    // Let the template dropdown close before pressing Download PDF: a press while it closes was
    // ignored, and the user had to click Download PDF by hand (2026-10-22).
    // (Escape only while the list is still open -- otherwise it would close the whole export dialog.)
    await run(tabId, () => {
      if (document.querySelector('[role="listbox"], [data-ui-name="Select.Popper"], [data-ui-name="DropdownMenu.Popper"]'))
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await sleep(1500);
    await run(tabId, installExportCapture, [], "MAIN");
    const download = ctx.waitForDownload("smr.seotooladda.com", 150_000);
    // Press, then check Semrush began (spinner on the card / "Your download will start" notice); press again if not.
    for (let press = 0; press < 3; press++) {
      if (!(await run(tabId, pressSelector, ['[data-test="lo-download-pdf-button"]']))) await run(tabId, clickByText, [["Download PDF"]]);
      if (await waitFor(tabId, downloadBegan, [], 6_000)) break;
    }

    // Whichever comes first: the file (blob in the page, or a real download), or Semrush's error notice.
    const end = Date.now() + 150_000;
    let file = null;
    let error = null;
    while (Date.now() < end && !file && !error) {
      const captured = await run(tabId, readCapturedExport, [], "MAIN").catch(() => null);
      if (captured?.base64) file = Uint8Array.from(atob(captured.base64), (c) => c.charCodeAt(0));
      file = file || download.result();
      // A download we caught but couldn't fetch, or Semrush's own "click here to download" link: fetch it in the page.
      const url = file ? null : download.url() || (await run(tabId, downloadLinkHref).catch(() => null));
      if (url) {
        const base64 = await run(tabId, fetchInPage, [url], "MAIN").catch(() => null);
        if (base64) file = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      }
      error = file ? null : await run(tabId, exportError).catch(() => null);
      if (!file && !error) await sleep(1500);
    }
    download.cancel();
    if (file) {
      const isPdf = file[0] === 0x25 && file[1] === 0x50 && file[2] === 0x44 && file[3] === 0x46; // %PDF
      if (!isPdf) throw new AgentError("FAILED", "Semrush returned a file that isn't a PDF.");
      return { bytes: file, fileName: `${task.domain}-semrush-site-audit-${kind}.pdf` };
    }
    await ctx.progress(`Semrush: "${error ?? "no file"}" -- trying again`);
    await sleep(8000);
  }
  throw new AgentError("FAILED", "Semrush's PDF download kept failing (\"Something went wrong\") for both the Full Report and the Overview. The audit itself is done -- try the export again later.");
}
