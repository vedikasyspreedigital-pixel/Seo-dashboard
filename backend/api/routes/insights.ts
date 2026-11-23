import { Router } from "express";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond } from "../../auth/ownership.js";
import { buildClientInsights, buildPortfolio } from "../../insights/clientInsights.js";

// Client view + portfolio (2026-11-23) -- see backend/insights/clientInsights.ts.
//   GET /api/insights/clients/:id            one client: trend, keywords across runs, reports, baselines
//   GET /api/insights/portfolio?workspaceId  every active client of a team

export const insightsRouter = Router();
insightsRouter.use(requireAuth);

insightsRouter.get("/clients/:id", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;
  res.json(await buildClientInsights(client.id));
});

insightsRouter.get("/portfolio", async (req, res) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(await buildPortfolio(workspaceId));
});
