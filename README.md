# serp-interpreter

A standalone replacement for the Make.com "Ranking Report Automation"
scenario. No Make.com involved — this service reads the sheet, calls
DataForSEO, has Claude match the target domain against the full result set,
and writes the outcome back.

```
Sheet (Pending / Error-Retry rows)
        │
        ▼
DataForSEO — full unfiltered top-100 organic results
        │                     │
     API fails             API succeeds
        │                     ▼
        │              Claude matches target domain
        │                against the 100 results
        │                     │            │
        │                 succeeds     fails after 3 tries
        ▼                     ▼               ▼
  Error - Retry          Completed       Needs Review
  (rank/URL blank)   (rank + URL set)  (rank/URL blank)
```

`Needs Review` is intentionally never `Error - Retry` — a bad Claude response
shouldn't cause the row to re-hit (and re-pay for) DataForSEO for a problem
the API didn't cause.

## Project structure

The repository has two application surfaces:

```
frontend/               — React + Vite frontend
  src/api/              — typed browser client and API models
  src/components/       — reusable UI grouped by feature
  src/hooks/            — client-side data fetching and polling
  src/pages/            — page-level composition

backend/                — Node + Express backend
  api/                  — HTTP app and route handlers
  dataforseo/           — provider clients and response mapping
  db/                   — Prisma client
  excel/                — workbook parsing and export
  runs/                 — run ingestion and orchestration
  statemachine/         — run and row transition rules
  worker/               — background run processing

prisma/                 — database schema and migrations
test/                   — backend tests
scripts/                — local data and batch utilities
```

The empty root `api/` and `lib/` directories are retained only as placeholders
from the earlier serverless prototype; active backend code is under `backend/`.

## Why this replaces `target`, not just `items[1]`

DataForSEO's `target` parameter pre-filters the SERP to a domain pattern
like `example.com*` before it's ever returned — it isn't a hint, it's a
filter. The old scenario passed it the full target **URL** (sheet column C),
which is not a supported pattern, so it silently returned an empty or wrong
result set for any row whose page wasn't an exact string match. That's the
actual bug behind the `accuracy_fix_v2…v6` history in your Make.com exports.

This service doesn't pass `target` at all (see `lib/dataforseo.js`) — it
pulls the full unfiltered top 100 and lets Claude do the matching, which is
also what makes "why isn't this ranking" debuggable: you get the real SERP,
not a pre-filtered guess.

## One-time setup

**1. DataForSEO** — grab your API login/password from the DataForSEO
dashboard (same account the Make.com connector used).

**2. Google service account** (so this service can read/write the sheet
without a human's OAuth session):

- Google Cloud Console → new project (or reuse one) → **APIs & Services →
  Enable** the Google Sheets API.
- **IAM & Admin → Service Accounts → Create** → create a JSON key.
- Open the "Rank Sheet" spreadsheet → **Share** → add the service account's
  `...@...iam.gserviceaccount.com` email as **Editor**.
- From the downloaded JSON, take `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  and `private_key` → `GOOGLE_PRIVATE_KEY` (keep the `\n` sequences literal).

**3. Anthropic** — an API key from the Anthropic Console.

**4.** Copy `.env.example` to `.env` and fill in all of the above, plus a
random `SHARED_SECRET`.

```bash
cd serp-interpreter
npm install
cp .env.example .env   # then edit .env
```

## Run it locally

```bash
npm install
npm --prefix frontend install

# Terminal 1: backend at http://localhost:3001
npm run backend:dev

# Terminal 2: frontend at the Vite URL shown by the command
npm run frontend
```

Vite proxies `/api` requests to the backend, so the browser does not need a
separate API URL or CORS configuration. The backend defaults to mock DataForSEO
responses; set `DATAFORSEO_LIVE=true` only when real API calls are intended.

For a production frontend build, run `npm run frontend:build`. Backend tests
run with `npm test`.

## Deploy to Vercel (for the HTTP trigger + future dashboard)

```bash
npm i -g vercel
vercel login
vercel
vercel env add ANTHROPIC_API_KEY
vercel env add CLAUDE_MODEL
vercel env add DATAFORSEO_LOGIN
vercel env add DATAFORSEO_PASSWORD
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
vercel env add GOOGLE_PRIVATE_KEY
vercel env add SPREADSHEET_ID
vercel env add SHEET_NAME
vercel env add SHARED_SECRET
vercel --prod
```

Trigger a run:

```bash
curl -X POST "https://<your-project>.vercel.app/api/process?limit=25" \
  -H "x-api-secret: <your SHARED_SECRET>"
```

Response is a per-row summary (status written, rank, matched URL, or the
error that caused an `Error - Retry` / `Needs Review`).

### Scheduling

Either:

- **Vercel Cron** — add a `crons` entry in `vercel.json` pointing at
  `/api/process` (Vercel Cron sends a GET by default; if you keep the POST
  guard, switch the handler to accept GET from Vercel's cron IP, or trigger
  it from an external scheduler that can POST — e.g. cron-job.org, or your
  own OS scheduler calling the curl command above).
- **Your own scheduler** hitting the same endpoint on whatever interval fits
  (e.g. every 15 minutes).

Note the batch `limit` — serverless functions have a max execution time, so
this processes rows in bounded batches rather than assuming one call clears
an unlimited backlog. Call it repeatedly, or raise `limit` together with
`maxDuration` once you know real row volume and per-row latency.

## Project layout

```
lib/dataforseo.js   — direct DataForSEO client (no target filter)
lib/claude.js        — the matching call to Claude, with retry + fallback
lib/sheets.js        — Google Sheets read/write (service account)
lib/pipeline.js      — wires the three together, per pending row
api/process.js       — HTTP trigger for the full pipeline (batch)
api/interpret-serp.js— HTTP trigger for just the Claude step, for testing
scripts/process-pending.js — local/cron entry point, no HTTP needed
```

## What's intentionally not here yet

- No pre-filter/exact-match shortcut before calling Claude — every row goes
  through the model for now, to validate accuracy in isolation. Worth adding
  once you're seeing real volume/cost (see the architecture doc).
- No dashboard UI yet — `api/process.js` is what a "Run" button will call.
- No report-generation / client-delivery pipeline — that's the next phase,
  once ranking data is trustworthy.
