import express from "express";
import { clientsRouter } from "./routes/clients.js";
import { overviewRouter } from "./routes/overview.js";
import { createRunsRouter } from "./routes/runs.js";
import { createReportsRouter, type ReportsRouterDeps } from "./routes/reports.js";
import { createMockClaudeAnalyst, createMockClaudeEmailDrafter } from "../reporting/mockClaudeClient.js";
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

// reportingDeps defaults to mocks: no ANTHROPIC_API_KEY and no email
// provider are configured anywhere in this codebase yet, so /api/reports
// always runs against mocks unless a caller explicitly injects real
// implementations (which don't exist yet either).
export function createApp(
  callDataForSeo: CallDataForSeoFn,
  dataForSeoMode: "live" | "mock",
  liveEndpointUrl?: string,
  reportingDeps: ReportsRouterDeps = {
    callClaudeAnalyst: createMockClaudeAnalyst(),
    callClaudeEmailDraft: createMockClaudeEmailDrafter(),
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
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use("/api/clients", clientsRouter);
  app.use("/api/overview", overviewRouter);
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

  return app;
}
