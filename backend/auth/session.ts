import type { Request, Response } from "express";
import { prisma } from "../db/client.js";

// Server-side sessions stored in the sessions table -- see prisma/schema.prisma
// for why this was chosen over JWT (instant revocation, no denylist needed).
// Cookie parsing/setting is hand-rolled (no `cookie-parser` dependency),
// matching this codebase's existing pattern of avoiding a package for
// something this small (see app.ts's CORS middleware).

export const SESSION_COOKIE_NAME = "serp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string) {
  return prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

/** Resolves a session cookie value to its still-valid User (with workspace memberships), or null if missing/expired/unknown. Never throws. */
export async function getUserForSession(sessionId: string | null) {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { include: { memberships: { include: { workspace: true } } } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await deleteSession(sessionId);
    return null;
  }
  if (!session.user.isActive) return null;
  return session.user;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function getSessionIdFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

/**
 * `secure`/`sameSite` are environment-conditional: local dev serves the
 * frontend and backend as same-origin (Vite proxies /api), so a plain
 * `lax` cookie over http works fine. Once frontend/backend are on separate
 * hosts (Vercel/Render) the browser sees this as cross-origin, which
 * requires `sameSite=none; secure` -- and `secure` cookies are only ever
 * sent over https, which production already is.
 */
function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    maxAge: SESSION_TTL_MS,
    path: "/",
  };
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}
