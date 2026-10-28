import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearFetchJobs, removeOldFetchFiles, startFetch } from "../backend/domainIntel/fetchJob.js";
import { domainReportDir } from "../backend/domainIntel/createDomainReport.js";
import type { FetchExportFn } from "../backend/domainIntel/fetchers/flikoverAhrefs.js";

// Audit 2026-10-27: a fetch for the same site in another country was handed the one still running.

test("startFetch: a double-click gets the running fetch; another country starts its own", async () => {
  clearFetchJobs();
  let release!: () => void;
  const slow: FetchExportFn = () => new Promise((resolve) => (release = () => resolve({ buffer: Buffer.from("Keyword,Position\nyoga,1"), fileName: "x.csv" })));
  const client = { id: "client-keys", workspaceId: null };
  try {
    const au = await startFetch({ source: "semrush", client, websiteUrl: "https://yogapeace.com.au", location: "au" }, { semrush: slow });
    const again = await startFetch({ source: "semrush", client, websiteUrl: "yogapeace.com.au", location: "au" }, { semrush: slow });
    assert.equal(again.id, au.id, "same site, tool and country: the running one");
    const uk = await startFetch({ source: "semrush", client, websiteUrl: "yogapeace.com.au", location: "uk" }, { semrush: slow });
    assert.notEqual(uk.id, au.id, "another country: its own fetch");
    assert.equal(uk.location, "uk");
  } finally {
    release?.();
    clearFetchJobs();
  }
});

// Audit 2026-10-27: fetched exports were only cleaned up while the server remembered their job -- after a
// restart they stayed forever. Same one-day rule at startup; newer files are kept.
test("removeOldFetchFiles: exports older than a day go, newer ones stay", async () => {
  const dir = domainReportDir("fetches");
  await mkdir(dir, { recursive: true });
  const old = path.join(dir, "old-test-export.csv");
  const fresh = path.join(dir, "fresh-test-export.csv");
  await writeFile(old, "x");
  await writeFile(fresh, "y");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(old, twoDaysAgo, twoDaysAgo);
  assert.ok((await removeOldFetchFiles()) >= 1);
  await assert.rejects(stat(old));
  await stat(fresh);
});