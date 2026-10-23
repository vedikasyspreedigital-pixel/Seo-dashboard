import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";

// Domain Intelligence Phase 2: fetches a client's Ahrefs "Organic keywords"
// CSV through Flikover (group-buy access), the same way a person does it --
// mapped with the user on 2026-10-16 (spikes/domain-intel-fetch/mapSession.mjs,
// two recorded walk-throughs + screenshots):
//   flikover.com/user/in/ahrefs.php -> "Click here to access Ahrefs" (opens
//   Ahrefs in a NEW TAB) -> Organic keywords for target + mode + country,
//   no comparison (the same address Ahrefs' own link uses) -> the TABLE's
//   Export (the chart has another) -> "All N" rows + CSV
//   (UTF-16) -> Export. The downloaded row count is checked against Ahrefs'
//   "N keywords".
//
// Rules this follows (shared paid account, used by the SEO team too):
// - Uses a SAVED login only (Playwright storageState from the one-time
//   human sign-in). Never types or stores a password, never logs in or out.
// - Runs in a normal VISIBLE browser: Flikover rejects a hidden (headless)
//   one with "Multiple Sessions Detected", and that is never worked around.
// - Stops at the first sign of a login page, session error or bot check and
//   reports it -- never retries on its own, never solves challenges.
// - One fetch at a time app-wide, with human-like pauses between steps.
// - Selectors are scoped to what the user actually clicked (placeholder,
//   button names, the export dialog) -- no page-wide guesses.

export type FetchErrorCode = "SESSION_EXPIRED" | "MULTIPLE_SESSIONS" | "BOT_CHECK" | "NO_SESSION" | "NO_DATA" | "TIMEOUT" | "FAILED" | "AGENT_OFFLINE";

export class FetchError extends Error {
  constructor(
    public code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchRequest {
  /** Bare domain, e.g. "yogapeaceaustralia.com". */
  domain: string;
  /** Semrush-style country code from the page ("au", "uk", ...). */
  location: string | null;
  onStep?: (step: string) => void;
}

export interface FetchedExport {
  buffer: Buffer;
  fileName: string;
}

export type FetchExportFn = (req: FetchRequest) => Promise<FetchedExport>;

const ACCESS_PAGE = "https://flikover.com/user/in/ahrefs.php";
const SITE_EXPLORER = "https://ahn.flikover.com/site-explorer";
/** Ahrefs' search scope. "subdomains" is Ahrefs' default (*.domain/*). */
export const AHREFS_MODE = "subdomains";

/** The page's Semrush codes -> Ahrefs country codes (ISO, so "uk" is "gb"). */
export function ahrefsCountry(location: string | null): string {
  const code = (location ?? "au").toLowerCase();
  return code === "uk" ? "gb" : code;
}

/** "https://www.example.com.au/path" -> "example.com.au". */
export function bareDomain(websiteUrl: string): string {
  return websiteUrl
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
}

/** Data rows in an Ahrefs CSV (UTF-16 or UTF-8): non-empty lines minus the header. */
export function countCsvRows(buffer: Buffer): number {
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString("utf16le") : buffer.toString("utf8");
  return Math.max(0, text.split(/\r?\n/).filter((l) => l.trim() !== "").length - 1);
}

const pause = (min = 1200, max = 2800) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

/** Throws the right FetchError if the page left Ahrefs for a Flikover login/error page or a bot check. */
async function assertStillSignedIn(page: Page) {
  const url = new URL(page.url());
  if (/challenges\.cloudflare|__cf_chl/.test(page.url()) || (await page.locator('iframe[src*="challenges.cloudflare.com"]').count()) > 0) {
    throw new FetchError("BOT_CHECK", "Flikover showed a \"Verify you are human\" check. Sign in again by hand; the robot never solves these.");
  }
  if (url.hostname === "flikover.com" || url.hostname === "www.flikover.com") {
    if (url.pathname === "/user/in/ahrefs.php") return; // the signed-in Access page
    const title = await page.title().catch(() => "");
    if (/error/i.test(url.pathname) || /multiple sessions/i.test(title)) {
      throw new FetchError("MULTIPLE_SESSIONS", "Flikover said \"Multiple Sessions Detected\" -- someone else is signed in to the account, or the saved login was replaced. Sign in again.");
    }
    throw new FetchError("SESSION_EXPIRED", "The saved Flikover login has expired. Sign in again.");
  }
}

export function createFlikoverAhrefsFetcher(opts: { sessionPath: string; headless?: boolean; launch?: () => Promise<Browser>; debugDir?: string }): FetchExportFn {
  return async ({ domain, location, onStep }) => {
    const step = (s: string) => onStep?.(s);
    try {
      await access(opts.sessionPath);
    } catch {
      throw new FetchError("NO_SESSION", "No saved Flikover login yet. Sign in once with the setup script.");
    }
    const { chromium } = await import("playwright");
    const browser = opts.launch ? await opts.launch() : await chromium.launch({ headless: opts.headless ?? false });
    let current: Page | null = null; // for the failure screenshot
    try {
      const context = await browser.newContext({ storageState: opts.sessionPath, acceptDownloads: true, viewport: { width: 1440, height: 900 } });

      // Same way in as a person: the Access page's "Click here to access Ahrefs" opens Ahrefs in a new tab.
      step("Opening Flikover");
      const portal = await context.newPage();
      current = portal;
      await portal.goto(ACCESS_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertStillSignedIn(portal);
      const accessLink = portal.getByText("Click here to access Ahrefs", { exact: true });
      await accessLink.waitFor({ state: "visible", timeout: 30_000 }).catch(async () => {
        await assertStillSignedIn(portal);
        throw new FetchError("FAILED", "Flikover's Ahrefs page has no \"Click here to access Ahrefs\" button -- is the Ahrefs subscription active?");
      });
      await pause();
      step("Opening Ahrefs");
      const [page] = await Promise.all([context.waitForEvent("page", { timeout: 60_000 }), accessLink.click()]);
      current = page;
      await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
      await page.waitForURL(/ahn\.flikover\.com/, { timeout: 60_000 }).catch(() => {});
      await assertStillSignedIn(page);
      await pause();

      // Organic keywords for the site + country -- the address Ahrefs' own "Organic keywords" link opens.
      const country = ahrefsCountry(location);
      step(`Organic keywords (${country.toUpperCase()})`);
      const keywordsUrl = new URL(`${SITE_EXPLORER}/organic-keywords`);
      keywordsUrl.searchParams.set("target", `${domain}/`);
      keywordsUrl.searchParams.set("mode", AHREFS_MODE);
      keywordsUrl.searchParams.set("country", country);
      // Today's keywords only. Without this Ahrefs may compare with last month and
      // list LOST keywords too (seen 2026-10-19: 128 rows instead of 74).
      keywordsUrl.searchParams.set("compareDate", "dontCompare");
      await page.goto(keywordsUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertStillSignedIn(page);
      // The keyword TABLE's toolbar ("N keywords" ... Columns | API | Export) -- the chart above has its own
      // Export button that opens a different dialog, so never a page-wide "Export".
      const tableToolbar = page
        .locator("div", { has: page.getByText(/^[\d,]+ keywords$/) })
        .filter({ has: page.getByRole("button", { name: "Columns" }) })
        .last();
      const exportButton = tableToolbar.getByRole("button", { name: "Export", exact: true });
      await exportButton.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {
        throw new FetchError("TIMEOUT", "Ahrefs' Organic keywords list didn't load (no Export button).");
      });
      // "74 keywords" above the table -- what the export must contain.
      const countText = await tableToolbar.getByText(/^[\d,]+ keywords$/).first().textContent({ timeout: 30_000 }).catch(() => null);
      const expected = countText ? Number(countText.replace(/[^\d]/g, "")) : null;
      if (expected === 0) throw new FetchError("NO_DATA", `Ahrefs has 0 organic keywords for ${domain} in ${country.toUpperCase()}.`);
      await pause(2000, 4000); // let the table finish loading

      step(expected !== null ? `Exporting ${expected} keywords` : "Exporting CSV");
      await exportButton.click();
      // The "Export" dialog: Number of rows (All N / Custom), Format (sometimes Google Sheets, CSV UTF-16,
      // CSV UTF-8), Export / Cancel. Bounded by the block holding BOTH the options and the Cancel button --
      // the options' own block doesn't contain the buttons (seen 2026-10-19).
      const dialog = page
        .locator("div", { has: page.getByText("Number of rows", { exact: true }) })
        .filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) })
        .last();
      await dialog.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
        throw new FetchError("TIMEOUT", "Ahrefs' Export dialog didn't open.");
      });
      await pause(500, 1000);
      // Both are the defaults; only change a radio that isn't already selected (clicking the
      // label text itself timed out on 2026-10-19).
      for (const radio of [dialog.getByRole("radio", { name: /^All [\d,]+$/ }), dialog.getByRole("radio", { name: "CSV (UTF-16, best for Excel)" })]) {
        if (!(await radio.isChecked({ timeout: 5_000 }).catch(() => true))) await radio.check({ timeout: 10_000 });
      }
      await pause(500, 1000);
      const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
      await dialog.getByRole("button", { name: "Export", exact: true }).first().click();
      const download = await downloadPromise.catch(() => {
        throw new FetchError("TIMEOUT", "Ahrefs didn't start the CSV download within 2 minutes.");
      });
      const filePath = await download.path();
      if (!filePath) throw new FetchError("FAILED", "The Ahrefs download failed.");
      const buffer = await readFile(filePath);
      if (buffer.length < 10) throw new FetchError("NO_DATA", "Ahrefs exported an empty file.");
      const exportedRows = countCsvRows(buffer);
      if (expected !== null && exportedRows < expected) {
        throw new FetchError("NO_DATA", `Ahrefs exported ${exportedRows} of ${expected} keywords -- the export was cut short.`);
      }

      // Keep the (possibly refreshed) login for next time. Never logs out.
      await context.storageState().then((state) => writeFile(opts.sessionPath, JSON.stringify(state)));
      step("Downloaded");
      return { buffer, fileName: download.suggestedFilename() || `${domain}-organic-keywords.csv` };
    } catch (err) {
      // Local debugging only (DOMAIN_INTEL_DEBUG_DIR): a picture of the screen where it stopped.
      if (opts.debugDir && current) {
        const file = path.join(opts.debugDir, `ahrefs-failed-${Date.now()}.png`);
        await mkdir(opts.debugDir, { recursive: true }).then(() => current!.screenshot({ path: file, fullPage: false })).catch(() => {});
        console.warn(`[domainIntel] Ahrefs fetch stopped (${(err as Error).message}); screenshot: ${file}`);
      }
      if (err instanceof FetchError) throw err;
      const msg = (err as Error).message ?? String(err);
      throw new FetchError(/timeout/i.test(msg) ? "TIMEOUT" : "FAILED", `Ahrefs fetch failed: ${msg.split("\n")[0].slice(0, 300)}`);
    } finally {
      await browser.close().catch(() => {});
    }
  };
}

/**
 * Mock (default, like DataForSEO/ClickUp): no browser, no Flikover. Returns
 * DOMAIN_INTEL_MOCK_AHREFS_FILE when set (a real export, for local testing),
 * else a tiny made-up Ahrefs-style CSV. Takes a few seconds so progress shows.
 */
export function createMockAhrefsFetcher(opts: { mockFilePath?: string; delayMs?: number } = {}): FetchExportFn {
  return async ({ domain, onStep }) => {
    onStep?.("Opening Ahrefs (mock)");
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 2500));
    if (opts.mockFilePath) {
      onStep?.("Downloaded (mock file)");
      return { buffer: await readFile(opts.mockFilePath), fileName: `${domain}-organic-keywords-mock.csv` };
    }
    const header = ["Keyword", "Informational", "Commercial", "Volume", "Current position"];
    const rows = [
      [`${domain.split(".")[0]} services`, "false", "true", "320", "3"],
      ["best local provider", "true", "true", "1200", "11"],
      ["how to choose a provider", "true", "false", "90", "27"],
    ];
    const text = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join("\t")).join("\r\n");
    onStep?.("Downloaded (mock)");
    return { buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), fileName: `${domain}-organic-keywords-mock.csv` };
  };
}

/** One fetch at a time app-wide: the shared account must never see two robot sessions at once. */
let queue: Promise<unknown> = Promise.resolve();
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
