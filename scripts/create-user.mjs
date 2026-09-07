import { prisma } from "../backend/db/client.js";
import { hashPassword } from "../backend/auth/password.js";

// One-off internal account creation -- there is no self-service signup and
// no user-management UI by design (an internal tool with a handful of
// seats doesn't need one). Run via tsx, not plain node (this imports
// backend/auth/password.ts, a TypeScript file):
//   npx tsx scripts/create-user.mjs <email> <password> <workspace-slug> [workspace-slug-2 ...]
// e.g.
//   npx tsx scripts/create-user.mjs vedika@syspreedigital.com "..." seo advanced-seo
// Passing more than one workspace slug gives that user membership in all
// of them (the admin/multi-workspace case) -- there's no separate "admin"
// flag needed for visibility, see WorkspaceMembership in prisma/schema.prisma.

const [, , email, password, ...workspaceSlugs] = process.argv;

if (!email || !password || workspaceSlugs.length === 0) {
  console.error("Usage: node scripts/create-user.mjs <email> <password> <workspace-slug> [more-workspace-slugs...]");
  console.error("Available workspace slugs: run `npm run prisma:seed` first if none exist yet.");
  process.exit(1);
}

const workspaces = await prisma.workspace.findMany({ where: { slug: { in: workspaceSlugs } } });
const foundSlugs = new Set(workspaces.map((w) => w.slug));
const missing = workspaceSlugs.filter((s) => !foundSlugs.has(s));
if (missing.length > 0) {
  console.error(`Unknown workspace slug(s): ${missing.join(", ")}. Run \`npm run prisma:seed\` to create the default workspaces first.`);
  process.exit(1);
}

const user = await prisma.user.upsert({
  where: { email: email.toLowerCase().trim() },
  update: { passwordHash: hashPassword(password) },
  create: { email: email.toLowerCase().trim(), passwordHash: hashPassword(password) },
});

for (const workspace of workspaces) {
  await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    update: {},
    create: { userId: user.id, workspaceId: workspace.id },
  });
}

console.log(`User ready: ${user.email} (${user.id}), member of: ${workspaces.map((w) => w.slug).join(", ")}`);
await prisma.$disconnect();
