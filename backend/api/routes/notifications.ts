import { Router } from "express";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";

// Backs the header bell + left-sliding notification panel. Same
// workspace-scoping pattern as overview.ts (query-param workspaceId,
// checked against req.authUser.workspaceIds) -- there's no per-resource
// :id to walk to a workspace here, so this is the simplest correct check
// rather than a findOwned*OrRespond-style helper.

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const LIST_LIMIT = 50;

notificationsRouter.get("/", async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    res.status(400).json({ error: "workspaceId query parameter is required" });
    return;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: "You do not have access to this workspace" });
    return;
  }

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    }),
    prisma.notification.count({ where: { workspaceId, read: false } }),
  ]);

  res.json({ notifications, unreadCount });
});

notificationsRouter.post("/mark-read", async (req, res) => {
  const workspaceId = req.body?.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: "You do not have access to this workspace" });
    return;
  }

  await prisma.notification.updateMany({
    where: { workspaceId, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});
