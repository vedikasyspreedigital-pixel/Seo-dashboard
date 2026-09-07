import type { NextFunction, Request, Response } from "express";
import { getSessionIdFromRequest, getUserForSession } from "./session.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  workspaceIds: string[];
}

declare module "express-serve-static-core" {
  interface Request {
    authUser?: AuthenticatedUser;
  }
}

/**
 * Attaches req.authUser (id/email/name/role + every workspace id this user
 * has a WorkspaceMembership row for) when a valid, unexpired session cookie
 * is present; responds 401 otherwise. Not applied to every route yet --
 * see the rollout plan (schema/resolution/auth-backend/scoping/frontend
 * land first, this gate is applied to the remaining routes last).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = getSessionIdFromRequest(req);
  const user = await getUserForSession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.authUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workspaceIds: user.memberships.map((m) => m.workspaceId),
  };
  next();
}
