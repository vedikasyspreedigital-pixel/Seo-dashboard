import { randomUUID } from "node:crypto";
import { prisma } from "../../backend/db/client.js";
import { hashPassword } from "../../backend/auth/password.js";
import { createSession, SESSION_COOKIE_NAME } from "../../backend/auth/session.js";

// Shared across test files that exercise requireAuth-gated routes
// (clients.ts, overview.ts, and eventually runs.ts/reports.ts once the
// final gate lands) -- creates a real User + Workspace + WorkspaceMembership
// + Session via Prisma directly (never through the HTTP login route, since
// these tests aren't testing login itself) and returns a Cookie header
// ready to attach to a supertest request.

export interface AuthFixture {
  user: { id: string; email: string };
  workspace: { id: string; slug: string; name: string };
  cookieHeader: string;
  cleanup: () => Promise<void>;
}

export async function createAuthenticatedSession(workspaceSlug = `test-workspace-${randomUUID()}`): Promise<AuthFixture> {
  const workspace = await prisma.workspace.create({
    data: { slug: workspaceSlug, name: `Test Workspace ${workspaceSlug}` },
  });
  const user = await prisma.user.create({
    data: {
      email: `test-user-${randomUUID()}@example.com`,
      passwordHash: hashPassword("irrelevant-for-these-tests"),
      memberships: { create: { workspaceId: workspace.id } },
    },
  });
  const session = await createSession(user.id);

  return {
    user: { id: user.id, email: user.email },
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    cookieHeader: `${SESSION_COOKIE_NAME}=${session.id}`,
    cleanup: async () => {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
    },
  };
}
