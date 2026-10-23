# SERP Console — SEO ranking & reporting dashboard

SySpree Digital's internal dashboard for SEO client work:

- **Ranking runs** — upload a client's keyword Excel, the backend checks each keyword's Google position
  through **DataForSEO**, and the results come back as an Excel.
- **Client reports** — a branded ranking PDF + Excel per client, compared against a pinned **baseline**
  (earlier report), with an editable email draft that is **sent through ClickUp** (Playwright drives the
  ClickUp email composer on the client's task).
- **Workspaces** — separate client lists for the *SEO* and *Advanced SEO* teams, each with its own ClickUp login.
- **Domain Intelligence** — enter a client's website and get 5 reports (below), made from the team's own
  SEO tools by a Chrome extension, and posted together as one ClickUp comment.

Frontend: React + Vite on **Vercel**. Backend: Node 22 + Express + Prisma/Postgres on **Railway**.

## Domain Intelligence — the 5 reports

The tools (Semrush, Ubersuggest and WooRank through seotooladda; Ahrefs through Flikover) have no API we can
use, so an **office Chrome extension** (`extension/`) does the clicking in a Chrome where someone is signed in.
It polls the backend for jobs, runs each in its own window, and uploads the file — it never types passwords
and stops for a person if a "verify you are human" check appears.

| # | Report | How it's made | File |
|---|---|---|---|
| 1 | **Keyword Analysis** | Organic keyword exports from Semrush, Ubersuggest and Ahrefs, one search intent per keyword (word patterns, then Gemini). With competitors: Semrush's top 3 organic competitors (auto, or typed by the team) are exported too, and a *Competitors* sheet puts the client and competitors side by side — position, landing page, traffic, difficulty, intent. | Excel |
| 2 | **Semrush Site Audit** | New Site Audit project (1,000 pages, run once) → wait for the crawl → Full Report PDF. | PDF |
| 3 | **WooRank Audit** | Create Review → Refresh → Download PDF (saved through Chrome's print engine). | PDF |
| 4 | **Gap & Competitor Analysis** | From report 1's competitor data: *Missing* and *Weak* keywords; Gemini picks the opportunities worth pursuing and writes the action plan. | Excel |
| 5 | **AI SEO Audit** | Gemini reads the WooRank and Semrush PDFs and fills the team's audit workbook: dashboard, checks per area, tech stack, action plan. | Excel |

Code: `backend/domainIntel/` (reports, jobs, agent queue), `backend/api/routes/domainIntel.ts` and
`agent.ts`, `frontend/src/pages/DomainIntelligencePage.tsx`, `extension/`.

## Project structure

```
frontend/      React + Vite app (pages, components, typed API client)
backend/       Express API
  api/           routes (auth, clients, runs, reports, baselines, compare, domainIntel, agent, ...)
  dataforseo/    DataForSEO client + response mapping
  reporting/     report PDFs/Excel, email drafts, ClickUp email sender
  baselines/     baseline Excel/PDF parsing (incl. OCR) and comparison
  domainIntel/   Domain Intelligence (see above)
  worker/        background run processing
prisma/        database schema, migrations, seed (workspaces)
extension/     "SERP Console Agent" Chrome extension (Domain Intelligence)
spikes/clickup-feasibility/   ClickUp login helper (npm run setup-session) -- still used
scripts/       one-off admin utilities (create-user, import-workspace-clients, diagnostics)
test/          backend tests (node:test)
```

## Run it locally

Needs **Node 22** (see `.nvmrc`) and **Postgres** (any local install or Docker; `.env.example` assumes port 5433).

```bash
npm install
npm --prefix frontend install
cp .env.example .env          # then fill in DATABASE_URL etc.
npx prisma migrate deploy
npm run prisma:seed           # creates the "seo" and "advanced-seo" workspaces
npx tsx scripts/create-user.mjs you@example.com "a-password" seo advanced-seo
npm run backend               # API on http://localhost:3001
npm run frontend              # app on http://localhost:5173 (proxies /api to the backend)
```

Everything external is **mock by default** — no DataForSEO spend, no ClickUp sends, no tool fetching —
until you set the matching switch in `.env` (`DATAFORSEO_LIVE`, `CLICKUP_EMAIL_LIVE`,
`CLICKUP_COMMENTS_LIVE`, `DOMAIN_INTEL_FETCH_MODE`). All settings are described in `.env.example`.

Tests (need the local Postgres running): `npm test`

## The ClickUp login (email + comments)

ClickUp is driven with a saved browser login (a Playwright "session file"), made by a person once:

```bash
cd spikes/clickup-feasibility && npm install
npm run setup-session                 # default workspace -> session/clickup-storage-state.json
npm run setup-session:advanced-seo    # Advanced SEO workspace's own login
```

A browser opens: log in to ClickUp (check it's the right account), then press Enter in the terminal.
For production, upload the file to the Railway volume (see Deploy, step 4).

## The Chrome extension (Domain Intelligence)

On the office computer's Chrome:

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `extension/` folder.
2. Extension **Settings**: server address (the Railway backend URL, or `http://localhost:3001` locally) and
   the **agent token** (= `DOMAIN_INTEL_AGENT_TOKEN` on the server). Optional: "Show me the job window" to watch it work.
3. In that Chrome: stay signed in to **seotooladda** (and **Flikover** for Ahrefs), and **allow pop-ups for
   seotooladda.com** (WooRank opens its review in a new tab).
4. Keep that Chrome open — it picks up jobs every 30 seconds. After changing extension code, click ↻ on its card.

The extension's popup also has a **Record** mode (pages + clicks + screenshots, never typed values) used to map new tool flows.

## Deploy

### Backend → Railway

`railway.json` sets the build/start/healthcheck; `nixpacks.toml` adds the Linux libraries Chromium needs
(without it Playwright's browser can't start on Railway). The rest is set up once in Railway:

1. **Project + Postgres** — new project from this repo; add the **Postgres** plugin.
2. **Volume** — on the backend service add a Volume mounted at `/var/data` (uploads, reports and ClickUp
   session files live there; without it they're lost on every redeploy).
3. **Variables** (service → Variables; mark secrets as secret):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `PORT` | leave unset (Railway sets it) |
   | `UPLOADS_DIR` | `/var/data/uploads` |
   | `REPORTS_DIR` | `/var/data/uploads/reports` |
   | `CLICKUP_SESSION_PATH` | `/var/data/uploads/clickup-storage-state.json` |
   | `CLICKUP_SESSION_PATH_ADVANCED_SEO` | `/var/data/uploads/clickup-storage-state-advanced-seo.json` |
   | `CORS_ORIGINS` | the Vercel app URL (comma-separated if several) |
   | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | DataForSEO credentials (secret) |
   | `DATAFORSEO_LIVE`, `CLICKUP_EMAIL_LIVE`, `CLICKUP_COMMENTS_LIVE` | `false` until deliberately going live |
   | `DOMAIN_INTEL_FETCH_MODE` | `agent` |
   | `DOMAIN_INTEL_AGENT_TOKEN` | a long random string (secret) — same value in the extension's Settings |
   | `GEMINI_API_KEY` | Google AI Studio key (secret) |

4. **ClickUp session files** — after `npm run setup-session` locally, copy them onto the volume:

   ```bash
   railway login && railway link
   railway ssh keys add   # first time only
   cat spikes/clickup-feasibility/session/clickup-storage-state.json | railway ssh --service <backend-service> "cat > /var/data/uploads/clickup-storage-state.json"
   cat spikes/clickup-feasibility/session/clickup-storage-state-advanced-seo.json | railway ssh --service <backend-service> "cat > /var/data/uploads/clickup-storage-state-advanced-seo.json"
   railway ssh --service <backend-service> "ls -la /var/data/uploads/"
   ```

   Log in to the right ClickUp account for each workspace — a wrong account makes every send fail with
   "You need access to this task".

Before deploying, check no ranking run is still processing (a deploy restarts the server).

### Frontend → Vercel

The Vercel project builds the `frontend/` folder (`frontend/vercel.json` sends every route to the app).
Set **`VITE_API_BASE_URL`** to the Railway backend URL (`https://<something>.up.railway.app`) in the Vercel
project's environment variables; it's baked in at build time, so redeploy after changing it.

## Notes

- Generated files (`reports/`, `uploads/`) and `.env` are git-ignored — never commit them; reports contain client data.
- Pushing is done from GitHub Desktop; Railway and Vercel deploy from `main`.
