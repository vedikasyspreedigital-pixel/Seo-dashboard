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
