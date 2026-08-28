# ClickUp automation feasibility spike

**Isolated throwaway spike.** Nothing here is imported by `backend/` or
`frontend/`, and this folder's `node_modules`/dependencies are entirely
separate from the root project's. It proves (or disproves) that ClickUp's
task Comment -> Email composer can be driven with Playwright, before any
of it gets built into the real reporting pipeline.

```
Test ClickUp Task
       |
   Playwright
       |
 Comment -> Email
       |
   Fill email
       |
  Attach test file
       |
      Send
       |
 Verify in ClickUp
```

## What this does NOT do

- Never touches `approveAndSend.ts`, `ranking_reports`, the API, Claude, or DataForSEO.
- Never sees, stores, or types your ClickUp password. You log in yourself, once, in a real visible browser window.
- Never sends to a real client. `TEST_RECIPIENT_EMAIL` must be an address you own/monitor.
- Never treats "the Send button was clicked" as success -- it only counts as verified if the email actually shows up in the task's history.
- Defaults to a **dry run** (fills everything, stops before clicking Send) so you can visually confirm the composer looks right first.

## Setup

```bash
cd spikes/clickup-feasibility
npm install
npx playwright install chromium
```

## 1. Log in once (manual, human-only)

```bash
npm run setup-session
```

A real Chromium window opens. Log into ClickUp yourself (including any
2FA/SSO). Once you're in your workspace, come back to the terminal and
press Enter. This saves an authenticated session file to
`session/clickup-storage-state.json` (gitignored) -- no password is ever
written anywhere.

## 2. Run the feasibility test (dry run first)

Point it at **one dedicated test task** -- never a real client task -- and
a recipient address you own:

```bash
CLICKUP_TASK_URL="https://app.clickup.com/t/xxxxxxx" \
TEST_RECIPIENT_EMAIL="you@your-own-domain.com" \
npm test
```

This opens the task, switches Comment -> Email, fills To/Subject/Body,
attaches `fixtures/test-report.html`, and **stops before clicking Send**.
Watch the browser window and confirm the composer actually looks right.

## 3. Run it for real (only once step 2 looks correct)

Same command, with `CONFIRM_SEND=true` added:

```bash
CLICKUP_TASK_URL="https://app.clickup.com/t/xxxxxxx" \
TEST_RECIPIENT_EMAIL="you@your-own-domain.com" \
CONFIRM_SEND=true \
npm test
```

This will click Send and then verify the email actually appears in the
task's activity/history before reporting success.

## Output

Every run writes:
- `results/<timestamp>__report.json` -- every step, PASS/FAIL/WARN/SKIP, plus a raw inventory of every input/button/contenteditable element found in the composer (this is the "discovered selectors" deliverable, since we don't have the real DOM ahead of time).
- `results/<timestamp>__*.png` -- a screenshot at each key checkpoint, regardless of pass/fail.

`results/` and `session/` are gitignored.
