import express from "express";
import multer from "multer";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { overviewRouter } from "./routes/overview.js";
import { notificationsRouter } from "./routes/notifications.js";
import { baselinesRouter } from "./routes/baselines.js";
import { compareReportsRouter } from "./routes/compareReports.js";
import { createRunsRouter } from "./routes/runs.js";
import { createReportsRouter, type ReportsRouterDeps } from "./routes/reports.js";
import { createDomainIntelRouter, type DomainIntelRouterDeps } from "./routes/domainIntel.js";
import { storageRouter } from "./routes/storage.js";
import { createAgentRouter } from "./routes/agent.js";
import { createMockCommentPoster } from "../domainIntel/clickupCommentPoster.js";
import { createMockEmailSender, isMock } from "../reporting/mockEmailSender.js";
import { requireAuth } from "../auth/requireAuth.js";
import { hideServerPathsInResponses } from "./hideServerPaths.js";
import type { CallDataForSeoFn } from "../worker/processRun.js";

// CORS: in local dev, the Vite dev server proxies /api to this server (see
// frontend/vite.config.ts), so requests are same-origin and no CORS is
// needed. Once the frontend and backend are hosted separately (e.g.
// frontend on Vercel, backend on Render), the browser calls this server
// cross-origin, so allowed origins are explicit and env-driven -- never a
// blanket "*", since responses can include real client data. No `cors`
// package dependency for something this small.
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Local development: the dashboard runs on some localhost port (5173, 5174, ...). Never in production. */
const isLocalDevOrigin = (origin: string) => process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// reportingDeps defaults to a mock email sender: no real email provider is
// configured anywhere in this codebase yet, so /api/reports always runs
// against the mock unless a caller explicitly injects a real one.
export function createApp(
  callDataForSeo: CallDataForSeoFn,
  dataForSeoMode: "live" | "mock",
  liveEndpointUrl?: string,
  reportingDeps: ReportsRouterDeps = {
    sendEmail: createMockEmailSender(),
  },
  domainIntelDeps: DomainIntelRouterDeps = { postComment: createMockCommentPoster() },
) {
  const app = express();
  // Railway puts one proxy in front of the app. Without this every request looked like it came from that
  // proxy, so the login limit (10 per 15 min) was shared by the WHOLE team (audit 2026-10-27).
  app.set("trust proxy", 1);
  // Small standard hardening (audit 2026-10-27): no "X-Powered-By: Express", no MIME sniffing, no full URLs in
  // Referer. Deliberately NO frame-blocking header: the dashboard shows the report PDF in a frame from here.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  // 2mb, not the 100kb default: confirming a baseline import sends every parsed row back, and Compare
  // Reports sends both reports' rows -- a ~1,500-keyword client hit 413. (A route-level json({ limit })
  // can't raise it: this parser runs first and the body is already read.)
  app.use(express.json({ limit: "2mb" }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      // Required for the browser to send/receive the session cookie
      // cross-origin (frontend on Vercel, backend on Render) -- only ever
      // set for an explicitly allow-listed origin, never alongside "*".
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Writes only from the dashboard itself (audit 2026-10-27): the session cookie is sent cross-site, so any
  // other website open in a signed-in browser could otherwise POST e.g. approve-and-send. Browsers always
  // send Origin on such a request; scripts/servers send none and are let through, and the office Chrome
  // agent signs in with its own token, not the cookie.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.path.startsWith("/api/agent/")) return next();
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin(origin)) return next();
    res.status(403).json({ error: "This request didn't come from the dashboard, so it was refused." });
  });

  app.use(hideServerPathsInResponses);

  app.use("/api/auth", authRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/clients", baselinesRouter);
  app.use("/api/overview", overviewRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/compare-reports", compareReportsRouter);
  app.use("/api/runs", createRunsRouter(callDataForSeo));
  app.use("/api/reports", createReportsRouter(reportingDeps));
  app.use("/api/domain-intel", createDomainIntelRouter(domainIntelDeps));
  app.use("/api/storage", storageRouter);
  // The office Chrome agent (Domain Intelligence fetching) -- token-protected, off unless DOMAIN_INTEL_AGENT_TOKEN is set.
  app.use("/api/agent", createAgentRouter());

  // Reports the actual mode/endpoint this running process was constructed
  // with -- not a config file's intent, but what this process's
  // callDataForSeo closure actually is. Lets a caller verify live-vs-mock
  // and which endpoint from outside, independent of console output (which
  // can be stale/from a different process).
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, pid: process.pid, dataForSeoMode, liveEndpointUrl: liveEndpointUrl ?? null }),
  );

  // What this process REALLY does with rankings, client emails and ClickUp comments -- the page shows a
  // "Test mode" banner when any is mock, because a mock send otherwise looks exactly like real delivery
  // (audit 2026-10-27). Signed-in users only.
  const deliveryMode = {
    dataForSeo: dataForSeoMode,
    email: isMock(reportingDeps.sendEmail) ? "mock" : "live",
    comments: isMock(domainIntelDeps.postComment) ? "mock" : "live",
  } as const;
  app.get("/api/delivery-mode", requireAuth, (_req, res) => res.json(deliveryMode));

  // Centralized error logging -- without this, an unhandled exception in any
  // route (most have no try/catch of their own) reaches Express 5's default
  // error handler, which responds with a bare 500 and logs nothing
  // server-side. This middleware logs first, then defers to that same
  // default response behavior (no stack trace leaked to the client; Express
  // only includes one when NODE_ENV !== "production").
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    // A request that's simply wrong (too big, unreadable) gets a clear 4xx, not a bare 500 (audit 2026-10-27).
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? "The file is too large for this upload." : `Upload problem: ${err.message}.` });
      return;
    }
    const status = (err as { status?: number; expose?: boolean }).status;
    if (typeof status === "number" && status >= 400 && status < 500 && (err as { expose?: boolean }).expose) {
      res.status(status).json({ error: status === 413 ? "The request is too large." : (err as Error).message });
      return;
    }
    console.error(`Unhandled error in ${req.method} ${req.path}:`, err);
    next(err);
  });

  return app;
}
