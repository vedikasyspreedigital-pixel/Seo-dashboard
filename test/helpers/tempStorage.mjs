// Loaded before every test file (`--import` in the "test" script): points the app's file storage at a
// throwaway folder, so test runs never pile files into the real reports/ and uploads/ (2026-10-26:
// 950 leftover files, mostly from tests). Each test process gets its own folder, removed on exit.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "serp-console-test-"));
process.env.REPORTS_DIR = path.join(root, "reports");
process.env.UPLOADS_DIR = path.join(root, "uploads");
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort -- it's in the OS temp folder anyway
  }
});

// Run queue (2026-11-23): tests share one database and run files in parallel, so a one-at-a-time queue would make
// one file's runs wait on another's. No limit by default here; the run-queue tests set their own.
process.env.RUN_QUEUE_CONCURRENCY ??= "0";
