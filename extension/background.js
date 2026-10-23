import { AgentError, waitForLoad } from "./lib/browser.js";
import { runAhrefs } from "./flows/ahrefs.js";
import { runSemrush, runSemrushCompetitors, runUbersuggest } from "./flows/seotooladda.js";
import { runSiteAudit } from "./flows/siteaudit.js";
import { runWooRank } from "./flows/woorank.js";

// SERP Console Agent -- background worker. Every 30s it asks the dashboard
// (Settings: server address + agent token) for a job; runs it in a window of
// THIS Chrome; uploads the exported file; reports each step so the dashboard
// shows live progress. One job at a time. It never types passwords, never
// logs in or out, and never clicks a "verify you are human" check -- it waits
// for a person instead.

const VERSION = chrome.runtime.getManifest().version;
const FLOWS = { ahrefs: runAhrefs, semrush: runSemrush, ubersuggest: runUbersuggest, siteaudit: runSiteAudit, woorank: runWooRank, competitors: runSemrushCompetitors };
// The sites each flow builds its export file on -- the browser's own copy of that download is dropped.
const EXPORT_ORIGINS = {
  ahrefs: "blob:https://ahn.flikover.com",
  semrush: "blob:https://smr.seotooladda.com",
  ubersuggest: "blob:https://ub.seotooladda.com",
  siteaudit: "blob:https://smr.seotooladda.com",
  woorank: "blob:https://wr.seotooladda.com",
};

// A flow waiting for a REAL download (a file served from the tool's server, not built in the page):
// the file is fetched here with the browser's own cookies, and the browser's copy is dropped.
let downloadWaiter = null;
function waitForDownload(host, timeoutMs) {
  const waiter = { host, bytes: null, url: null, until: Date.now() + timeoutMs };
  downloadWaiter = waiter;
  return {
    result: () => (Date.now() < waiter.until ? waiter.bytes : null),
    // The address of the download we caught but couldn't fetch here (e.g. a blob only the page can read).
    url: () => waiter.url,
    cancel: () => {
      if (downloadWaiter === waiter) downloadWaiter = null;
    },
  };
}

async function settings() {
  const s = await chrome.storage.local.get({ serverUrl: "http://localhost:3001", token: "", enabled: true });
  return { ...s, serverUrl: s.serverUrl.replace(/\/+$/, "") };
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get("status");
  await chrome.storage.local.set({ status: { ...status, ...patch, at: Date.now() } });
}

async function api(path, init = {}) {
  const { serverUrl, token } = await settings();
  const res = await fetch(`${serverUrl}/api/agent${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 401) throw new Error("The server rejected the agent token -- check it in the extension's Settings.");
  if (res.status === 404) throw new Error("The server has the agent switched off (DOMAIN_INTEL_AGENT_TOKEN not set) or the address is wrong.");
  return res;
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let busy = false;
let jobWindowId = null;
let activeTool = null;

async function runTask(task) {
  const flow = FLOWS[task.tool];
  const ctx = {
    progress: async (step, needsHuman = false) => {
      await setStatus({ state: needsHuman ? "needs_human" : "working", job: `${task.tool} · ${task.domain}`, step });
      await api(`/tasks/${task.id}/progress`, json({ step, needsHuman }));
    },
    // Each job runs in its own normal (not minimised -- pages must render) window, closed afterwards.
    openTab: async (url) => {
      // "Show me the job window" (Settings): open it in front so a person can watch every step.
      const { watch = false } = await chrome.storage.local.get("watch");
      const win = await chrome.windows.create({ url, focused: watch, width: 1400, height: 900 });
      jobWindowId = win.id;
      const tabId = win.tabs[0].id;
      await new Promise((r) => setTimeout(r, 500));
      await waitForLoad(tabId);
      return tabId;
    },
    waitForDownload,
  };
  try {
    if (!flow) throw new AgentError("FAILED", `This agent can't fetch "${task.tool}" yet.`);
    activeTool = task.tool;
    const { bytes, fileName } = await flow(task, ctx);
    await ctx.progress("Uploading the export to SERP Console");
    const form = new FormData();
    const type = fileName.endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : fileName.endsWith(".pdf")
        ? "application/pdf"
        : "text/csv";
    form.append("file", new Blob([bytes], { type }), fileName);
    const res = await api(`/tasks/${task.id}/result`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
    await setStatus({ state: "idle", lastResult: `✓ ${task.tool} · ${task.domain} · ${fileName}`, step: null, job: null });
  } catch (err) {
    const code = err instanceof AgentError ? err.code : "FAILED";
    const message = err?.message || String(err);
    await api(`/tasks/${task.id}/fail`, json({ code, message })).catch(() => {});
    await setStatus({ state: "idle", lastResult: `✗ ${task.tool} · ${task.domain}: ${message}`, step: null, job: null });
    // Watching (Settings): leave the failed job's window open on the page where it stopped.
    const { watch = false } = await chrome.storage.local.get("watch");
    if (watch) jobWindowId = null;
  } finally {
    activeTool = null;
    if (jobWindowId !== null) await chrome.windows.remove(jobWindowId).catch(() => {});
    jobWindowId = null;
  }
}

async function poll() {
  if (busy) return;
  const { token, enabled } = await settings();
  if (!enabled || !token) {
    await setStatus({ state: "off", error: token ? null : "Set the server address and agent token in Settings." });
    return;
  }
  busy = true;
  try {
    const res = await api(`/tasks/next?version=${encodeURIComponent(VERSION)}`);
    await setStatus({ connected: true, error: null, lastPollAt: Date.now() });
    if (res.status === 204) {
      await setStatus({ state: "idle" });
      return;
    }
    if (!res.ok) throw new Error(`Server answered ${res.status}.`);
    await runTask(await res.json());
  } catch (err) {
    await setStatus({ connected: false, error: err?.message || String(err) });
  } finally {
    busy = false;
  }
}

// The export file is captured from the page, so the browser's own copy of it isn't needed.
chrome.downloads.onCreated.addListener((item) => {
  const url = item.url || item.finalUrl || "";
  if (activeTool && EXPORT_ORIGINS[activeTool] && url.startsWith(EXPORT_ORIGINS[activeTool])) {
    chrome.downloads.cancel(item.id).then(() => chrome.downloads.erase({ id: item.id })).catch(() => {});
    return;
  }
  // A file a flow is waiting for -- from the tool's server, or any PDF (Semrush serves its Site Audit
  // PDF from another address): fetch it ourselves (same cookies); if we can't, the flow fetches it in the page.
  const waiter = downloadWaiter;
  const isPdf = item.mime === "application/pdf" || /\.pdf($|\?)/i.test(item.filename || url);
  if (activeTool && waiter && Date.now() < waiter.until && (url.startsWith(`https://${waiter.host}`) || isPdf)) {
    chrome.downloads.cancel(item.id).then(() => chrome.downloads.erase({ id: item.id })).catch(() => {});
    waiter.url = url;
    if (/^(https?|data):/.test(url))
      fetch(url, { credentials: "include" })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((buf) => {
          if (buf) waiter.bytes = new Uint8Array(buf);
        })
        .catch(() => {});
  }
});

// ---- Record mode: notes pages/clicks (from recorder.js) + a screenshot after each, for building new flows ----

let shotTimer = null;
async function addRecordEntry(entry, tab) {
  const { recordingSteps = [] } = await chrome.storage.local.get("recordingSteps");
  recordingSteps.push({ t: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ recordingSteps });
  if (entry.kind === "click" || entry.kind === "page") {
    // ~1.5s later, so a dropdown or dialog the click opened is in the picture.
    clearTimeout(shotTimer);
    shotTimer = setTimeout(async () => {
      try {
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
        const { recordingSteps: steps = [] } = await chrome.storage.local.get("recordingSteps");
        steps.push({ t: new Date().toISOString(), kind: "screenshot", url: entry.url, image });
        await chrome.storage.local.set({ recordingSteps: steps });
      } catch {
        // tab closed or not visible -- skip this picture
      }
    }, 1500);
  }
}

// What a download looks like while recording (name/type only -- the file itself stays in Downloads).
chrome.downloads.onCreated.addListener(async (item) => {
  const { recording } = await chrome.storage.local.get({ recording: false });
  if (!recording) return;
  const { recordingSteps = [] } = await chrome.storage.local.get("recordingSteps");
  recordingSteps.push({ t: new Date().toISOString(), kind: "download", mime: item.mime, filename: item.filename, urlStart: (item.url || "").slice(0, 60) });
  await chrome.storage.local.set({ recordingSteps });
});

chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "poll" && poll());
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "poll-now") poll().then(() => reply({ ok: true }));
  else if (msg?.type === "record" && sender.tab) addRecordEntry(msg.entry, sender.tab).then(() => reply({ ok: true }));
  else if (msg?.type === "record-start")
    chrome.storage.local.set({ recording: true, recordingSteps: [] }).then(() => reply({ ok: true }));
  else if (msg?.type === "record-stop") chrome.storage.local.set({ recording: false }).then(() => reply({ ok: true }));
  else reply({ ok: false });
  return true;
});
