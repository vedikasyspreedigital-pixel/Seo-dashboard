import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveWorkspaceId,
  readStoredWorkspaceId,
  writeStoredWorkspaceId,
  clearStoredWorkspaceId,
  type KeyValueStorage,
} from "../src/utils/workspaceSelection.js";

// In-memory stand-in for window.localStorage -- these tests run under plain
// Node (no DOM), so a real localStorage isn't available; this fake proves
// the exact same read/write/clear/isolation behavior a real one would give.
function makeFakeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

test("resolveActiveWorkspaceId: with nothing stored, falls back to the first available workspace", () => {
  const workspaces = [{ id: "workspace-seo" }, { id: "workspace-advanced-seo" }];
  assert.equal(resolveActiveWorkspaceId(null, workspaces), "workspace-seo");
});

test("resolveActiveWorkspaceId: restores a stored id the user still belongs to", () => {
  const workspaces = [{ id: "workspace-seo" }, { id: "workspace-advanced-seo" }];
  assert.equal(resolveActiveWorkspaceId("workspace-advanced-seo", workspaces), "workspace-advanced-seo");
});

test("resolveActiveWorkspaceId: a stored id the user no longer belongs to is NEVER restored -- falls back to the first available workspace instead", () => {
  const workspaces = [{ id: "workspace-seo" }, { id: "workspace-advanced-seo" }];
  assert.equal(resolveActiveWorkspaceId("workspace-user-was-removed-from", workspaces), "workspace-seo");
});

test("resolveActiveWorkspaceId: no workspaces at all resolves to null regardless of what's stored", () => {
  assert.equal(resolveActiveWorkspaceId("workspace-seo", []), null);
  assert.equal(resolveActiveWorkspaceId(null, []), null);
});

test("persistence round-trip: write then read (simulating select -> refresh) returns the same id", () => {
  const storage = makeFakeStorage();
  writeStoredWorkspaceId("user-1", "workspace-advanced-seo", storage);
  assert.equal(readStoredWorkspaceId("user-1", storage), "workspace-advanced-seo");
});

test("clearing: clearStoredWorkspaceId removes a previously written selection", () => {
  const storage = makeFakeStorage();
  writeStoredWorkspaceId("user-1", "workspace-advanced-seo", storage);
  clearStoredWorkspaceId("user-1", storage);
  assert.equal(readStoredWorkspaceId("user-1", storage), null);
});

test("per-user isolation: a selection stored for one user never appears when reading another user's key", () => {
  const storage = makeFakeStorage();
  writeStoredWorkspaceId("user-1", "workspace-seo", storage);
  writeStoredWorkspaceId("user-2", "workspace-advanced-seo", storage);

  assert.equal(readStoredWorkspaceId("user-1", storage), "workspace-seo");
  assert.equal(readStoredWorkspaceId("user-2", storage), "workspace-advanced-seo");
  assert.notEqual(readStoredWorkspaceId("user-1", storage), readStoredWorkspaceId("user-2", storage));
});

test("reading with no storage backend available never throws, returns null", () => {
  assert.equal(readStoredWorkspaceId("user-1", null), null);
});

test("writing/clearing with no storage backend available never throws", () => {
  assert.doesNotThrow(() => writeStoredWorkspaceId("user-1", "workspace-seo", null));
  assert.doesNotThrow(() => clearStoredWorkspaceId("user-1", null));
});
