import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/api/client.js";

// 2026-10-16: a single failed GET during a backend restart made list pages
// show "No reports yet" as if the data were gone. Reads now retry through a
// brief outage; anything that keeps failing still surfaces as an error.

const responder = (statuses: (number | "network")[]) => {
  let calls = 0;
  const request = async () => {
    const s = statuses[Math.min(calls++, statuses.length - 1)];
    if (s === "network") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: s });
  };
  return { request, calls: () => calls };
};

test("withRetry: a 503 / network error during a restart is retried until the backend answers", async () => {
  const r = responder([503, "network", 200]);
  const res = await withRetry(r.request, [0, 0, 0]);
  assert.equal(res.status, 200);
  assert.equal(r.calls(), 3);
});

test("withRetry: real answers (200, 404, 401, 500) are returned immediately, never retried", async () => {
  for (const status of [200, 404, 401, 500]) {
    const r = responder([status]);
    assert.equal((await withRetry(r.request, [0, 0, 0])).status, status);
    assert.equal(r.calls(), 1, `status ${status} called once`);
  }
});

test("withRetry: gives up after the last retry -- the outage then shows as an error, not as empty data", async () => {
  const down = responder([502]);
  assert.equal((await withRetry(down.request, [0, 0])).status, 502);
  assert.equal(down.calls(), 3);

  const offline = responder(["network"]);
  await assert.rejects(withRetry(offline.request, [0, 0]), TypeError);
  assert.equal(offline.calls(), 3);
});
