import { prisma } from "../backend/db/client.js";

// One-time backfill for the workspace-layer migration (see
// prisma/migrations/20260907073758_add_workspace_layer): tags every
// existing Client row created by the test suite / manual spike testing as
// isTestData, using the exact naming convention already established across
// every test/*.test.ts helper ("API Test ...", "Reports API Test ...").
// Deliberately does NOT touch workspaceId on any row -- every client,
// test or real, stays workspaceId: null until explicitly triaged (test
// clients stay excluded from both workspaces forever via isTestData; real
// pre-existing clients need a human to assign them to a workspace).
// Safe to re-run: only ever sets isTestData true for matching rows, never
// unsets it, never touches non-matching rows.

const dbUrl = process.env.DATABASE_URL ?? "(not set)";
console.log(`Connected to: ${dbUrl}`);

const result = await prisma.client.updateMany({
  where: {
    isTestData: false,
    OR: [{ name: { startsWith: "API Test" } }, { name: { startsWith: "Reports API Test" } }],
  },
  data: { isTestData: true },
});

console.log(`Tagged ${result.count} existing client(s) as isTestData: true.`);

const remaining = await prisma.client.count({ where: { isTestData: false } });
console.log(`${remaining} client(s) remain isTestData: false, workspaceId: null -- these are the real clients that need manual workspace triage.`);

await prisma.$disconnect();
