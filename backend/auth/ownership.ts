import type { Request, Response } from "express";
import { prisma } from "../db/client.js";

// Shared workspace-ownership gate for every endpoint that accepts a
// clientId/runId/reportId from the caller (path param, query param, or body).
// requireAuth only proves someone is logged in -- it says nothing about
// whether the specific resource they're asking for belongs to one of their
// workspaces. These helpers are that check, applied the same way everywhere:
// 404 (never 403) on a mismatch, so a foreign resource's existence is never
// revealed. Same convention clients.ts already established; runs.ts and
// reports.ts now use the exact same helpers instead of re-implementing it.

export interface OwnershipOptions {
  /**
   * When true, ALSO requires the client to be active and not archived --
   * pass this at every MUTATING call site (create/start/cancel a run;
   * create/build/edit/approve-and-send/reject/regenerate/draft a report).
   * Omit it (the default) for read-only GETs, so historical data on an
   * archived/inactive client stays viewable for authorized users -- this is
   * a business-rule check, not a security leak, so it responds 409 with a
   * clear reason rather than 404.
   */
  requireActive?: boolean;
}

function respondArchived(res: Response): null {
  res.status(409).json({ error: "This client is archived or inactive -- no new actions can be performed for it." });
  return null;
}

/** 404s (never leaks 403 across workspaces) unless the client belongs to one of the caller's workspaces. Returns the client row on success. */
export async function findOwnedClientOrRespond(req: Request, res: Response, id: string, options: OwnershipOptions = {}) {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client || !client.workspaceId || !req.authUser!.workspaceIds.includes(client.workspaceId)) {
    res.status(404).json({ error: "Client not found" });
    return null;
  }
  if (options.requireActive && (!client.isActive || client.archivedAt)) return respondArchived(res);
  return client;
}

/** Same guarantee for a run, verified through Run -> Client -> workspaceId. Returns the run (with its client included) on success. */
export async function findOwnedRunOrRespond(req: Request, res: Response, id: string, options: OwnershipOptions = {}) {
  const run = await prisma.rankingRun.findUnique({ where: { id }, include: { client: true } });
  if (!run || !run.client.workspaceId || !req.authUser!.workspaceIds.includes(run.client.workspaceId)) {
    res.status(404).json({ error: "Run not found" });
    return null;
  }
  if (options.requireActive && (!run.client.isActive || run.client.archivedAt)) return respondArchived(res);
  return run;
}

/** Same guarantee for a report, verified through Report -> Run -> Client -> workspaceId (not the denormalized Report.clientId). Returns the report (with run.client included) on success. */
export async function findOwnedReportOrRespond(req: Request, res: Response, id: string, options: OwnershipOptions = {}) {
  const report = await prisma.rankingReport.findUnique({ where: { id }, include: { run: { include: { client: true } } } });
  if (!report || !report.run.client.workspaceId || !req.authUser!.workspaceIds.includes(report.run.client.workspaceId)) {
    res.status(404).json({ error: "Report not found" });
    return null;
  }
  if (options.requireActive && (!report.run.client.isActive || report.run.client.archivedAt)) return respondArchived(res);
  return report;
}
