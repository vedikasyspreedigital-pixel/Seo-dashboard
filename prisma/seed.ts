import { prisma } from "../backend/db/client.js";

// Minimal, idempotent seed: just the two Workspace rows this app currently
// needs. Safe to re-run -- upserts by the unique slug, never duplicates.
// Deliberately does not seed any User/WorkspaceMembership rows: real
// accounts are created by a one-off internal script once real emails/
// passwords are known, not hardcoded here.

const WORKSPACES = [
  { slug: "seo", name: "SEO" },
  { slug: "advanced-seo", name: "Advanced SEO" },
];

for (const workspace of WORKSPACES) {
  const result = await prisma.workspace.upsert({
    where: { slug: workspace.slug },
    update: { name: workspace.name },
    create: workspace,
  });
  console.log(`Workspace ready: ${result.slug} (${result.id})`);
}

await prisma.$disconnect();
