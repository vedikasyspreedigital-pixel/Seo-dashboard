// Pure diagnostics. Read-only investigation of the live ClickUp task's
// activity/history feed -- specifically, the DOM around entries for emails
// we already know were sent for real (two real test sends made this week).
// No filling, no clicking, no attaching, never touches Send. Purpose:
// figure out whether ClickUp's activity feed exposes any identifier
// STRONGER than plain subject-line text -- a stable id, timestamp, or
// message reference -- that a pre-send duplicate check could key off
// instead of (or alongside) a subject-text substring search.
//
// Usage:
//   node diagnoseActivityHistory.mjs

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'session', 'clickup-storage-state.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const TASK_URL = 'https://app.clickup.com/t/86d45e14k';
// The two subjects we know were actually sent for real this week -- used
// only to LOCATE the activity entries in the DOM, never typed/clicked.
const KNOWN_SENT_SUBJECTS = [
  'SEO Ranking Report – Sep 8, 2026 to Sep 10, 2026',
  'SEO Ranking Report – Sep 8, 2026 to Sep 8, 2026',
];

const runId = new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  await page.goto(TASK_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  if (/login|auth/i.test(page.url())) {
    throw new Error(`Session expired -- redirected to ${page.url()}. Re-run setup-session.mjs.`);
  }

  const taskViewLoaded = await page
    .getByText(/^(Status|Assignees|Priority)$/i)
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!taskViewLoaded) {
    throw new Error(`Task panel never rendered within 20s at ${page.url()}.`);
  }
  // Give the activity feed a moment to finish rendering/settling.
  await page.waitForTimeout(1500);

  const report = await page.evaluate((subjects) => {
    function describeEl(el, htmlLen = 1200) {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className.slice(0, 200) : null,
        dataAttrs: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0,
        outerHTML: (el.outerHTML || '').slice(0, htmlLen),
      };
    }

    function findSubjectHits(subject) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.includes(subject)) continue;
        const textEl = node.parentElement;
        if (!textEl) continue;

        // Walk up looking for the smallest ancestor that looks like a
        // distinct "activity entry" / "feed item" container -- collect
        // every ancestor's id/data-* attrs up to 8 levels so we can see
        // which level (if any) carries a stable per-entry identifier.
        const ancestors = [];
        let node2 = textEl;
        for (let depth = 0; depth < 8 && node2; depth++) {
          ancestors.push({ depth, ...describeEl(node2, 300) });
          node2 = node2.parentElement;
        }

        hits.push({ matchedText: node.nodeValue.trim().slice(0, 200), textEl: describeEl(textEl, 300), ancestors });
      }
      return hits;
    }

    return {
      subjectHits: subjects.map((subject) => ({ subject, hits: findSubjectHits(subject) })),
    };
  }, KNOWN_SENT_SUBJECTS);

  await page.screenshot({ path: path.join(RESULTS_DIR, `${runId}__activity-history.png`), fullPage: true });

  const reportPath = path.join(RESULTS_DIR, `${runId}__activity-history-diagnosis.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nDiagnosis written to: ${reportPath}`);
  console.log(`Screenshot: ${path.join(RESULTS_DIR, `${runId}__activity-history.png`)}`);
  for (const { subject, hits } of report.subjectHits) {
    console.log(`\n--- subject: "${subject}" -- ${hits.length} match(es) ---`);
    for (const hit of hits) {
      console.log(`  matched text: "${hit.matchedText}"`);
      for (const a of hit.ancestors) {
        const idPart = a.id ? ` id="${a.id}"` : '';
        const dataPart = Object.keys(a.dataAttrs).length ? ` ${JSON.stringify(a.dataAttrs)}` : '';
        console.log(`    [depth ${a.depth}] <${a.tag}${idPart}${dataPart}> classes="${a.classes ?? ''}"`);
      }
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error('diagnoseActivityHistory crashed:', err);
  process.exit(1);
});
