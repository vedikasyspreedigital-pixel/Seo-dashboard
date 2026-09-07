import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";

// One-time import of real clients from the two ClickUp task-listing sheets
// into their respective workspaces, with each client's ClickUp Task ID
// saved as the primary mapping (ClientReportConfig.clickupTaskId) and the
// Task URL saved as the fallback (clickupTaskUrl) -- exactly the existing
// ClientReportConfig columns, no new fields invented.
//
// Usage:
//   npx tsx scripts/import-workspace-clients.mjs --dry-run
//   npx tsx scripts/import-workspace-clients.mjs

const DRY_RUN = process.argv.includes("--dry-run");

// Rows confirmed with the user to be template/test artifacts, not real
// clients -- excluded by their ClickUp Task ID (robust to row-number
// drift), not by row index.
const EXCLUDED_TASK_IDS = new Set([
  "f219vh", // "TEMPLATE - MENTION URL HERE"
  "86cu9jdmg", // "ClickUp Tech Team Testing task for email issue"
  "86d439r3q", // "Basic SEO Audits" -- service category, not a client
  "86d439t0c", // "Detailed Website Audit" -- service category, not a client
]);

const SOURCES = [
  { file: "C:\\Users\\admin\\Downloads\\SEO_Tasks_Listing.xlsx", workspaceSlug: "seo" },
  { file: "C:\\Users\\admin\\Downloads\\Advanced_SEO_Tasks_Listing.xlsx", workspaceSlug: "advanced-seo" },
];

/** "https://www.ldfitouts.com/" -> "ldfitouts.com"; plain business names ("KALA DARSHAN GEMS") pass through unchanged. */
function cleanClientName(rawName) {
  return rawName
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

async function readTasksSheet(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  const rows = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    // Columns are 1-indexed: 1 = Sr. No., 2 = Task Name, 3 = Task ID, 4 = Task URL.
    const rawName = row.getCell(2).value;
    const taskId = row.getCell(3).value;
    const taskUrlCell = row.getCell(4).value;
    const taskUrl = taskUrlCell && typeof taskUrlCell === "object" ? (taskUrlCell.text ?? taskUrlCell.hyperlink) : taskUrlCell;
    if (!rawName || !taskId) continue;
    rows.push({ rawName: String(rawName), taskId: String(taskId), taskUrl: taskUrl ? String(taskUrl) : null });
  }
  return rows;
}

const DEFAULT_REPORT_CONFIG = {
  reportTone: "professional",
  sectionsEnabled: ["summary"],
  metricsEnabled: ["averageRank", "top3", "top10", "notIn100"],
  recipients: [], // not present in the source sheets -- must be added per client before any report can actually be sent (NO_RECIPIENTS otherwise)
  reportingFrequency: "manual",
  templateId: "standard-v1",
};

let totalCreated = 0;
let totalSkippedExisting = 0;

for (const { file, workspaceSlug } of SOURCES) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } });
  const rows = await readTasksSheet(file);

  console.log(`\n=== ${workspaceSlug} (${file}) ===`);
  console.log(`${rows.length} total rows, ${rows.filter((r) => EXCLUDED_TASK_IDS.has(r.taskId)).length} excluded as template/test rows`);

  for (const row of rows) {
    if (EXCLUDED_TASK_IDS.has(row.taskId)) {
      console.log(`  SKIP (excluded): "${row.rawName}" (${row.taskId})`);
      continue;
    }
    const name = cleanClientName(row.rawName);

    const existing = await prisma.clientReportConfig.findFirst({ where: { clickupTaskId: row.taskId } });
    if (existing) {
      console.log(`  SKIP (already imported): "${name}" (${row.taskId})`);
      totalSkippedExisting++;
      continue;
    }

    console.log(`  ${DRY_RUN ? "[DRY RUN] would create" : "CREATE"}: "${name}" -> workspace=${workspaceSlug}, taskId=${row.taskId}, taskUrl=${row.taskUrl}`);
    totalCreated++;

    if (!DRY_RUN) {
      const client = await prisma.client.create({
        data: { name, workspaceId: workspace.id, isTestData: false },
      });
      await prisma.clientReportConfig.create({
        data: {
          clientId: client.id,
          clickupTaskId: row.taskId,
          clickupTaskUrl: row.taskUrl,
          ...DEFAULT_REPORT_CONFIG,
        },
      });
    }
  }
}

console.log(`\n${DRY_RUN ? "[DRY RUN] Would create" : "Created"} ${totalCreated} client(s). Skipped ${totalSkippedExisting} already-imported (by clickupTaskId).`);
await prisma.$disconnect();
