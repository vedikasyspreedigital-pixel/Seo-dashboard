import { Router } from "express";
import { prisma } from "../../db/client.js";
import { verifyPassword } from "../../auth/password.js";
import { createSession, deleteSession, getSessionIdFromRequest, getUserForSession, setSessionCookie, clearSessionCookie } from "../../auth/session.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string" || email.length === 0 || password.length === 0) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { memberships: { include: { workspace: true } } },
  });

  // Same generic error whether the email doesn't exist or the password is
  // wrong -- never reveal which one it was.
  if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const session = await createSession(user.id);
  setSessionCookie(res, session.id);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    workspaces: user.memberships.map((m) => ({ id: m.workspace.id, slug: m.workspace.slug, name: m.workspace.name })),
  });
});

authRouter.post("/logout", async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  const user = await getUserForSession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    workspaces: user.memberships.map((m) => ({ id: m.workspace.id, slug: m.workspace.slug, name: m.workspace.name })),
  });
});
