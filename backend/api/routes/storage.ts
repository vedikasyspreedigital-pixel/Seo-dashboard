import { Router } from "express";
import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../../auth/requireAuth.js";

// "Storage" on the Settings page (2026-10-16): how full the uploads disk is
// and what is using it. On Railway the uploads volume is small (434 MB) and
// filled up once already (ClickUp debug snapshots, 15 Oct), which made every
// upload and report PDF fail. Read-only -- cleanup stays manual: deleting a
// run on the Runs page removes its files.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same env-var/fallback conventions as runs.ts (uploads) and reports.ts (report PDFs).
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, "../../../uploads");
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../../reports");

export type StorageCategory = "reportPdfs" | "extraPdfs" | "domainReports" | "uploadedExcels" | "debugSnapshots" | "other";

/** Which bucket a file belongs to, from where it lives and its name. */
export function categorize(filePath: string): StorageCategory {
  const rel = path.relative(REPORTS_DIR, filePath);
  const inReports = !rel.startsWith("..") && !path.isAbsolute(rel);
  const name = path.basename(filePath);
  if (inReports) {
    const top = rel.split(path.sep)[0];
    if (top === "extra") return "extraPdfs";
    if (top === "domain-intel") return "domainReports";
    if (name.toLowerCase().endsWith(".pdf")) return "reportPdfs";
  }
  if (name.startsWith("debug-")) return "debugSnapshots";
  if (/\.(xlsx|xls|csv)$/i.test(name)) return "uploadedExcels";
  return "other";
}

async function walk(dir: string, seen: Set<string>, totals: Record<StorageCategory, number>, depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // folder doesn't exist (yet) -- nothing stored there
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (seen.has(full)) continue;
    seen.add(full);
    if (e.isDirectory()) {
      if (e.name !== "lost+found") await walk(full, seen, totals, depth + 1);
    } else if (e.isFile()) {
      totals[categorize(full)] += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
}

export const storageRouter = Router();
storageRouter.use(requireAuth);

storageRouter.get("/", async (_req, res) => {
  const totals: Record<StorageCategory, number> = { reportPdfs: 0, extraPdfs: 0, domainReports: 0, uploadedExcels: 0, debugSnapshots: 0, other: 0 };
  const seen = new Set<string>();
  // REPORTS_DIR first so its files are labelled by their report folder even
  // when it sits inside UPLOADS_DIR (as on Railway: /var/data/uploads/reports).
  await walk(REPORTS_DIR, seen, totals);
  await walk(UPLOADS_DIR, seen, totals);

  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const fs = await statfs(UPLOADS_DIR);
    disk = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
  } catch {
    disk = null; // uploads folder not created yet (fresh local setup)
  }
  res.json({ disk, usedByApp: totals, appTotalBytes: Object.values(totals).reduce((a, b) => a + b, 0) });
});
