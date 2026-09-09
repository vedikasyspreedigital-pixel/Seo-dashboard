import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveClientId,
  readStoredClientId,
  writeStoredClientId,
  clearStoredClientId,
  type KeyValueStorage,
} from "../src/utils/clientSelection.js";

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

test("resolveActiveClientId: never falls back to clients[0] when nothing was ever stored", () => {
  const clients = [{ id: "client-a" }, { id: "client-b" }];
  assert.equal(resolveActiveClientId(null, clients), null);
});

test("resolveActiveClientId: restores a stored id that's present in the current client list", () => {
  const clients = [{ id: "client-a" }, { id: "client-b" }];
  assert.equal(resolveActiveClientId("client-b", clients), "client-b");
});

test("resolveActiveClientId: an invalid/foreign/deleted/inactive/archived stored id is cleared to null, never substituted with another client", () => {
  const clients = [{ id: "client-a" }, { id: "client-b" }];
  // A stored id absent from the current list covers every one of these
  // cases identically -- deleted, deactivated, archived, or belonging to a
  // different workspace all just mean "not in this workspace's active list."
  assert.equal(resolveActiveClientId("client-deleted-or-foreign", clients), null);
});

test("resolveActiveClientId: an empty client list never resolves anything, even with a stored id", () => {
  assert.equal(resolveActiveClientId("client-a", []), null);
});

test("persistence round-trip: write then read (simulating select -> refresh) returns the same id", () => {
  const storage = makeFakeStorage();
  writeStoredClientId("workspace-seo", "client-a", storage);
  assert.equal(readStoredClientId("workspace-seo", storage), "client-a");
});

test("clearing: clearStoredClientId removes a previously written selection", () => {
  const storage = makeFakeStorage();
  writeStoredClientId("workspace-seo", "client-a", storage);
  clearStoredClientId("workspace-seo", storage);
  assert.equal(readStoredClientId("workspace-seo", storage), null);
});

test("workspace isolation: a selection stored for one workspace never appears when reading another workspace's key", () => {
  const storage = makeFakeStorage();
  writeStoredClientId("workspace-seo", "client-in-seo", storage);
  writeStoredClientId("workspace-advanced-seo", "client-in-advanced-seo", storage);

  assert.equal(readStoredClientId("workspace-seo", storage), "client-in-seo");
  assert.equal(readStoredClientId("workspace-advanced-seo", storage), "client-in-advanced-seo");

  // Switching workspaces must never read back the OTHER workspace's stored
  // client -- an SEO selection must never resolve while looking at
  // Advanced SEO's key, and vice versa.
  assert.notEqual(readStoredClientId("workspace-seo", storage), readStoredClientId("workspace-advanced-seo", storage));
});

test("workspace isolation end-to-end: a client valid in one workspace is correctly rejected when resolved against another workspace's client list", () => {
  const storage = makeFakeStorage();
  writeStoredClientId("workspace-seo", "shared-looking-id", storage);

  // The id was stored under "workspace-seo", so reading it back under
  // "workspace-advanced-seo" (a different key) must yield nothing --
  // exactly what happens on a real workspace switch.
  const storedForOtherWorkspace = readStoredClientId("workspace-advanced-seo", storage);
  assert.equal(storedForOtherWorkspace, null);
  assert.equal(resolveActiveClientId(storedForOtherWorkspace, [{ id: "shared-looking-id" }]), null);
});

test("reading with no storage backend available (e.g. window.localStorage inaccessible) never throws, returns null", () => {
  assert.equal(readStoredClientId("workspace-seo", null), null);
});

test("writing/clearing with no storage backend available never throws", () => {
  assert.doesNotThrow(() => writeStoredClientId("workspace-seo", "client-a", null));
  assert.doesNotThrow(() => clearStoredClientId("workspace-seo", null));
});
