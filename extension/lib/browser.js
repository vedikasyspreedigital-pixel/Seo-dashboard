// Small helpers for driving a tab of THIS Chrome (the one the team is signed in
// to). Nothing here types passwords, logs in/out, or touches a "verify you
// are human" check: waitForHuman() only waits for a person to tick it.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A short, human-paced pause between steps. */
export const pause = (min = 1200, max = 2800) => sleep(min + Math.random() * (max - min));

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Runs func(...args) inside the tab and returns its (JSON-serialisable) result. world: "ISOLATED" | "MAIN". */
export async function run(tabId, func, args = [], world = "ISOLATED") {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return res?.result;
}

export async function tabUrl(tabId) {
  return (await chrome.tabs.get(tabId)).url ?? "";
}

/** Resolves once the tab has finished loading (or after timeoutMs, without error -- the caller checks the page). */
export function waitForLoad(tabId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(), done);
  });
}

export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  await waitForLoad(tabId);
}

/** Polls predicate(...args) in the tab until it returns a truthy value; returns it, or null after timeoutMs. */
export async function waitFor(tabId, predicate, args = [], timeoutMs = 30_000, intervalMs = 750, world = "ISOLATED") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const value = await run(tabId, predicate, args, world);
      if (value) return value;
    } catch {
      // page mid-navigation -- try again
    }
    await sleep(intervalMs);
  }
  return null;
}

/** In-page: is a Cloudflare / "verify you are human" check showing? */
export function pageHasHumanCheck() {
  const title = document.title || "";
  return (
    /just a moment|attention required|verify you are human/i.test(title) ||
    !!document.querySelector('iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"], #challenge-form') ||
    /verify you are human/i.test(document.body?.innerText?.slice(0, 2000) ?? "")
  );
}

/** How long a job waits for a person to sign in to a tool before giving up (the server allows 15 min). */
export const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

/**
 * The tab is on a tool's sign-in page: instead of failing the job (2026-10-29, the team's ask), bring the window
 * to the front, ask for a person in a notification and WAIT until they've signed in -- then open `reopenUrl`
 * (the tool's access page) again and carry on. Never types anything itself. `await signedOut(tabId)` tells
 * whether the tab is (still) on the sign-in page. Returns true if it waited, false if no sign-in was needed.
 */
export async function waitForSignIn(tabId, ctx, { where, signedOut, reopenUrl }) {
  if (!(await signedOut(tabId))) return false;
  await ctx.progress(`Sign in to ${where} in the window that just opened -- the report continues by itself afterwards`, true);
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true, state: "maximized" }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  chrome.notifications.create(`signin-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon.png",
    title: `SERP Console: sign in to ${where}`,
    message: `Please sign in to ${where} in the window that just opened. The report continues by itself afterwards.`,
    priority: 2,
    requireInteraction: true,
  });
  const end = Date.now() + SIGN_IN_WAIT_MS;
  while (Date.now() < end) {
    await sleep(3000);
    const url = await tabUrl(tabId).catch(() => "");
    if (!url) throw new AgentError("FAILED", `The ${where} window was closed while waiting for the sign-in.`);
    if (!(await signedOut(tabId))) {
      await ctx.progress(`Signed in to ${where} -- continuing`);
      await pause();
      await navigate(tabId, reopenUrl);
      // Signed in, but the tool still sends us back to its sign-in page: keep waiting.
      if (await signedOut(tabId)) continue;
      return true;
    }
  }
  throw new AgentError("SESSION_EXPIRED", `Nobody signed in to ${where} on this computer within ${SIGN_IN_WAIT_MS / 60000} minutes.`);
}

/**
 * If a "verify you are human" check is showing, brings the window to the front,
 * shows a notification and WAITS (up to 15 min) for a person to tick it. Never
 * clicks it itself.
 */
export async function waitForHuman(tabId, ctx, where) {
  if (!(await run(tabId, pageHasHumanCheck).catch(() => false))) return;
  await ctx.progress(where, true);
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true, state: "maximized" }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  chrome.notifications.create(`human-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon.png",
    title: "SERP Console needs you",
    message: `Please tick "verify you are human" in the window that just opened (${where}). The export continues by itself afterwards.`,
    priority: 2,
  });
  const end = Date.now() + 15 * 60 * 1000;
  while (Date.now() < end) {
    await sleep(3000);
    const still = await run(tabId, pageHasHumanCheck).catch(() => true);
    if (!still) {
      await ctx.progress(`${where} -- verified, continuing`);
      await pause();
      return;
    }
  }
  throw new AgentError("BOT_CHECK", 'Nobody ticked "verify you are human" on this computer within 15 minutes.');
}
