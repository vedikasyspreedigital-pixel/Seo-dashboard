// Read-only: is a posted Domain Intelligence comment on the task, with its file?
// Opens the task once, reads the comment that contains <marker>, closes. Never clicks or types.
//   node spikes/domain-intel-fetch/checkClickUpComment.mjs <taskId> <storage-state.json> <marker>
import { chromium } from 'playwright';

const [taskId, statePath, marker] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ storageState: statePath })).newPage();
  await page.goto(`https://app.clickup.com/t/${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const hit = page.getByText(marker).first();
  const found = await hit.waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false);
  let comment = null;
  if (found) {
    comment = await hit.evaluate((el) => {
      let n = el;
      for (let i = 0; i < 12 && n; i++, n = n.parentElement) if (/\.xlsx/i.test(n.innerText)) break;
      return (n ?? el).innerText.replace(/\n{2,}/g, '\n').slice(0, 800);
    });
  }
  console.log(JSON.stringify({ found, occurrences: await page.getByText(marker).count(), comment }, null, 1));
} finally {
  await browser.close();
}
