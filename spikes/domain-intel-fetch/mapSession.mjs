// Domain Intelligence Phase 2 -- one-time, HUMAN-DRIVEN sign-in + screen mapping.
//
// Opens a real, visible browser. YOU sign in (seotooladda / Flikover) and YOU
// click through the export flow once (e.g. Semrush -> Domain Overview -> URL +
// location -> Organic Positions -> Export). This script never types, clicks or
// navigates for you. It only:
//   - logs which page you're on (URL path; query values redacted),
//   - logs what you clicked (tag, id, name, role, aria-label, data-* ids, short
//     text, CSS path) so selectors can be written from it,
//   - logs which field you typed into -- NEVER what you typed, and nothing at
//     all for password fields,
//   - saves any file you download (the export) so its columns can be checked,
//   - on Enter, saves the session cookies (Playwright storageState) so later
//     fetches reuse the login without ever seeing a password.
//
// Run from the repo root:
//   node spikes/domain-intel-fetch/mapSession.mjs seotooladda
//   node spikes/domain-intel-fetch/mapSession.mjs flikover https://<flikover login url>
// Output: spikes/domain-intel-fetch/session/<tool>-storage-state.json,
//         session/<tool>-map.jsonl, session/downloads/<file>  (all gitignored)

import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { access, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_URLS = { seotooladda: 'https://seotooladda.com/user/login.php' };
const tool = process.argv[2];
const startUrl = process.argv[3] || START_URLS[tool];
if (!tool || !/^[a-z0-9-]+$/.test(tool) || !startUrl) {
  console.error('Usage: node spikes/domain-intel-fetch/mapSession.mjs <seotooladda|flikover> [start url]');
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session');
const downloadsDir = path.join(dir, 'downloads');
const SESSION_PATH = path.join(dir, `${tool}-storage-state.json`);
const MAP_PATH = path.join(dir, `${tool}-map.jsonl`);
const shotsDir = path.join(dir, 'shots');
let shotNo = 0;
// A screenshot ~1.5s after each click (dropdowns/dialogs have opened by then), so the screens can be seen, not just logged.
const shotTimers = new WeakMap();
function scheduleShot(page, label) {
  clearTimeout(shotTimers.get(page));
  shotTimers.set(page, setTimeout(async () => {
    const file = path.join(shotsDir, `${String(++shotNo).padStart(3, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`);
    await page.screenshot({ path: file }).then(() => console.log(`[shot] ${file}`), () => {});
  }, 1500));
}

/** Path only; query/hash values replaced so tokens never land in the log. */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    const q = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&');
    return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`;
  } catch {
    return String(raw).split(/[?#]/)[0];
  }
}

const log = async (entry) => {
  const line = { t: new Date().toISOString(), ...entry };
  await appendFile(MAP_PATH, JSON.stringify(line) + '\n');
  console.log(`[${entry.kind}]`, entry.url ?? '', entry.el ? JSON.stringify(entry.el) : entry.file ?? '');
};

// Runs inside every page/frame. Reports element identity only -- never values.
const RECORDER = () => {
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const pathOf = (n) => {
      const parts = [];
      for (let i = 0; n && n.nodeType === 1 && i < 6; i++, n = n.parentElement) {
        let p = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
        const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
        if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
        parts.unshift(p);
      }
      return parts.join(' > ');
    };
    const data = {};
    for (const a of el.attributes) if (a.name.startsWith('data-') && a.value.length < 60) data[a.name] = a.value;
    const isSecret = el.tagName === 'INPUT' && el.type === 'password';
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      role: el.getAttribute('role') || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      placeholder: isSecret ? undefined : el.getAttribute('placeholder') || undefined,
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').split(/[?#]/)[0] : undefined,
      text: isSecret || ['INPUT', 'TEXTAREA'].includes(el.tagName) ? undefined : (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60) || undefined,
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 80) || undefined,
      data: Object.keys(data).length ? data : undefined,
      path: pathOf(el),
    };
  };
  const target = (e) => e.target.closest('button, a, input, select, textarea, [role], [onclick], label, li, span, div') || e.target;
  document.addEventListener('click', (e) => window.__mapLog?.({ kind: 'click', el: describe(target(e)) }), true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    // Which field changed -- never its value (a <select>'s chosen option text is kept, it's a menu choice like a country).
    const choice = el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : undefined;
    window.__mapLog?.({ kind: el.type === 'password' ? 'password-field' : 'field', el: describe(el), choice });
  }, true);
};

async function main() {
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(shotsDir, { recursive: true });
  console.log('Launching a real, visible browser window...');
  const browser = await chromium.launch({ headless: false });
  // Reuse the saved login when there is one (no sign-in needed); else start signed out.
  const saved = await access(SESSION_PATH).then(() => SESSION_PATH, () => undefined);
  if (saved) console.log('Using the saved login from last time.');
  const context = await browser.newContext({ acceptDownloads: true, viewport: null, storageState: saved });
  await context.exposeBinding('__mapLog', async ({ frame, page }, entry) => {
    await log({ ...entry, url: safeUrl(frame.url()) });
    if (entry.kind === 'click') scheduleShot(page, entry.el?.text || entry.el?.aria || entry.el?.tag || 'click');
  });
  await context.addInitScript(RECORDER);

  const watch = (page) => {
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      log({ kind: 'page', url: safeUrl(f.url()) }).catch(() => {});
      scheduleShot(page, new URL(f.url()).pathname || 'page');
    });
    page.on('download', async (d) => {
      const file = path.join(downloadsDir, `${tool}-${Date.now()}-${d.suggestedFilename()}`);
      await d.saveAs(file);
      await log({ kind: 'download', url: safeUrl(page.url()), file });
    });
  };
  context.on('page', (p) => { log({ kind: 'new-tab', url: safeUrl(p.url()) }).catch(() => {}); watch(p); });

  const page = await context.newPage();
  await page.goto(startUrl);

  console.log('\n============================================================');
  console.log(`1. Sign in to ${tool} yourself in the browser window (this script never sees the password).`);
  console.log('2. Then click through the export ONCE, the normal way, at normal speed:');
  console.log('   open the tool -> enter a client domain + location -> search -> export.');
  console.log('3. Let the export file finish downloading.');
  console.log('Do NOT log out at the end -- that would kill the saved session.');
  console.log('============================================================\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('When the export has downloaded, press Enter here to save the session and close... ');
  rl.close();

  await context.storageState({ path: SESSION_PATH });
  console.log(`\nSession saved to: ${SESSION_PATH}`);
  console.log(`Screen map saved to: ${MAP_PATH}`);
  await browser.close();
}

main().catch((err) => {
  console.error('mapSession failed:', err);
  process.exit(1);
});
