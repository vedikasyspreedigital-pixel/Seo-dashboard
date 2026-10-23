// Read-only: can a saved ClickUp login open a task? Opens the task page once,
// reports what loaded, closes. Never clicks, types or posts.
//   node spikes/domain-intel-fetch/checkClickUpTask.mjs <taskId> <storage-state.json>
import { chromium } from 'playwright';

const [taskId, statePath] = process.argv.slice(2);
if (!taskId || !statePath) {
  console.error('Usage: node checkClickUpTask.mjs <taskId> <storage-state.json>');
  process.exit(1);
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ storageState: statePath })).newPage();
  await page.goto(`https://app.clickup.com/t/${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const loaded = await page.getByText(/^(Status|Assignees|Priority)$/i).first().waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false);
  const hasCommentBar = (await page.locator('[data-test="comment-bar__send-btn"]').count()) > 0;
  const emailMode = await page.locator('[data-test="email-communicators__subject"]').first().isVisible().catch(() => false);
  const u = new URL(page.url());
  console.log(JSON.stringify({ landedOn: u.origin + u.pathname, taskLoaded: loaded, title: (await page.title()).slice(0, 120), hasCommentBar, composerInEmailMode: emailMode }));
} finally {
  await browser.close();
}
