# Deploying the backend to Railway

Railway replaces Render as the backend host. The frontend stays on Vercel, unchanged.
`railway.json` in the repo root covers the build/start/healthcheck config; everything
below (database, volume, env vars) has to be done once from the Railway dashboard or
CLI, since Railway has no single-file equivalent of `render.yaml` that provisions all
of it declaratively.

## 1. Create the project and Postgres

1. In Railway, create a new project from this GitHub repo.
2. Add a **Postgres** plugin to the project (Railway provisions it and exposes a
   `DATABASE_URL`-style connection string automatically as a reference variable).

## 2. Add a persistent volume

The app needs one persistent volume for uploaded Excel files, generated PDFs, and the
ClickUp Playwright session file — all three env vars below point into it. Without
this, everything written to disk is lost on every redeploy, same risk as on Render.

1. On the backend service, add a **Volume**, mount path `/data`.

## 3. Environment variables (Railway service → Variables)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | reference the Postgres plugin's connection variable (Railway lets you reference another service's variable directly, e.g. `${{Postgres.DATABASE_URL}}`) |
| `PORT` | leave unset — Railway injects its own `PORT` and the app already reads `process.env.PORT` |
| `UPLOADS_DIR` | `/data/uploads` |
| `REPORTS_DIR` | `/data/uploads/reports` |
| `CLICKUP_SESSION_PATH` | `/data/uploads/clickup-storage-state.json` |
| `CORS_ORIGINS` | `https://frontend-azure-pi-30.vercel.app,http://localhost:5173` (update if the Vercel URL ever changes) |
| `DATAFORSEO_LIVE` | `false` to start |
| `CLICKUP_EMAIL_LIVE` | `false` to start |
| `DATAFORSEO_LOGIN` | your real value — mark as a **secret** variable |
| `DATAFORSEO_PASSWORD` | your real value — mark as a **secret** variable |

Leave the two `*_LIVE` flags `false` until you're deliberately ready for real spend /
real sends — same fail-closed-to-mock behavior as before, this is app code, not
Railway-specific. (There is no Claude/AI variable anymore -- the app has no AI step;
report analysis and the email draft are both fully deterministic.)

## 4. ClickUp session file (same manual step as before, platform doesn't change this)

Once `CLICKUP_EMAIL_LIVE` is ready to flip to `true`, the Playwright session file still
has to be produced by a human login and placed on the volume:

1. Locally: `npm run setup-session` (in `spikes/clickup-feasibility`) — opens a real
   browser, log in to ClickUp yourself, press Enter when done.
2. Upload the resulting `clickup-storage-state.json` to the Railway volume at
   `/data/uploads/clickup-storage-state.json` (via Railway's volume file browser, or a
   one-off `railway run` / SFTP-style copy — whichever Railway's current tooling
   supports at the time).

## 5. Frontend (Vercel) — one change

Once the Railway service has a URL (`https://<something>.up.railway.app` by default),
update the Vercel project's `VITE_API_BASE_URL` build-time env var to point at it, and
redeploy the frontend so the new URL is baked into the built bundle.

## Notes

- `render.yaml` is left in the repo as a reference/fallback — it's no longer the active
  deploy config once Railway is wired up. Safe to delete later if you're confident you
  won't go back to Render.
- Nothing in the application code changed for this move — every storage path was
  already environment-variable-driven, so this is purely a hosting/config swap.
