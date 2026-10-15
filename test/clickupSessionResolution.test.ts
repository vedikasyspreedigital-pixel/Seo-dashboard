import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionStatePath } from "../backend/reporting/clickupEmailSender.js";

// Pure-function coverage for per-workspace ClickUp session selection --
// no DB, no Playwright. See approveAndSend.test.ts for the integration
// path (approveAndSendReport actually resolving and passing workspaceSlug
// through from a report's client).

test("resolveSessionStatePath: a workspace with its own entry uses that session", () => {
  const resolved = resolveSessionStatePath("advanced-seo", { "advanced-seo": "/data/advanced-seo-session.json" }, "/data/default-session.json");
  assert.equal(resolved, "/data/advanced-seo-session.json");
});

test("resolveSessionStatePath: a workspace with NO entry falls back to the default session", () => {
  const resolved = resolveSessionStatePath("seo", { "advanced-seo": "/data/advanced-seo-session.json" }, "/data/default-session.json");
  assert.equal(resolved, "/data/default-session.json");
});

test("resolveSessionStatePath: no workspace at all falls back to the default session", () => {
  assert.equal(resolveSessionStatePath(null, { "advanced-seo": "/data/advanced-seo-session.json" }, "/data/default-session.json"), "/data/default-session.json");
  assert.equal(resolveSessionStatePath(undefined, { "advanced-seo": "/data/advanced-seo-session.json" }, "/data/default-session.json"), "/data/default-session.json");
});

test("resolveSessionStatePath: an undefined map (no per-workspace config at all) always falls back to the default session", () => {
  const resolved = resolveSessionStatePath("advanced-seo", undefined, "/data/default-session.json");
  assert.equal(resolved, "/data/default-session.json");
});

// 2026-10-15: 319 debug snapshots (410 MB) filled the 434 MB uploads volume
// (ENOSPC on every upload/PDF). Only the newest few may stay, and nothing
// but debug-* files is ever touched.
test("pruneDebugArtifacts: keeps only the newest debug-* files and never touches other files", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { pruneDebugArtifacts } = await import("../backend/reporting/clickupEmailSender.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "debug-prune-"));
  try {
    for (let i = 0; i < 20; i++) {
      const f = path.join(dir, `debug-before-email-click-${String(i).padStart(2, "0")}.html`);
      await fs.writeFile(f, "x");
      const t = new Date(Date.UTC(2026, 9, 1, 0, i)); // file 19 is the newest
      await fs.utimes(f, t, t);
    }
    await fs.writeFile(path.join(dir, "clickup-storage-state.json"), "{}");
    await fs.writeFile(path.join(dir, "AKT Automation Template.xlsx"), "x");

    await pruneDebugArtifacts(dir, 10);

    const left = (await fs.readdir(dir)).sort();
    assert.deepEqual(left.filter((n) => n.startsWith("debug-")), Array.from({ length: 10 }, (_, i) => `debug-before-email-click-${i + 10}.html`));
    assert.ok(left.includes("clickup-storage-state.json") && left.includes("AKT Automation Template.xlsx"), "non-debug files untouched");

    await pruneDebugArtifacts(path.join(dir, "does-not-exist")); // never throws
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
