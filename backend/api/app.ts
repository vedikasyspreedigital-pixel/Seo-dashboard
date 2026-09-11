import express from "express";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { overviewRouter } from "./routes/overview.js";
import { notificationsRouter } from "./routes/notifications.js";
import { baselinesRouter } from "./routes/baselines.js";
import { createRunsRouter } from "./routes/runs.js";
import { createReportsRouter, type ReportsRouterDeps } from "./routes/reports.js";
import { createMockEmailSender } from "../reporting/mockEmailSender.js";
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
) {
  const app = express();
  app.use(express.json());

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

  app.use("/api/auth", authRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/clients", baselinesRouter);
  app.use("/api/overview", overviewRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/runs", createRunsRouter(callDataForSeo));
  app.use("/api/reports", createReportsRouter(reportingDeps));

  // Reports the actual mode/endpoint this running process was constructed
  // with -- not a config file's intent, but what this process's
  // callDataForSeo closure actually is. Lets a caller verify live-vs-mock
  // and which endpoint from outside, independent of console output (which
  // can be stale/from a different process).
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, pid: process.pid, dataForSeoMode, liveEndpointUrl: liveEndpointUrl ?? null }),
  );

  // Centralized error logging -- without this, an unhandled exception in any
  // route (most have no try/catch of their own) reaches Express 5's default
  // error handler, which responds with a bare 500 and logs nothing
  // server-side. This middleware logs first, then defers to that same
  // default response behavior (no stack trace leaked to the client; Express
  // only includes one when NODE_ENV !== "production").
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`Unhandled error in ${req.method} ${req.path}:`, err);
    next(err);
  });

  return app;
}
