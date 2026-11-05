// In-memory stand-in for DataForSEO's Standard queue (standardClient.ts),
// used when DATAFORSEO_LIVE isn't "true" -- the same safety default as
// mockClient.ts. Tasks become ready `readyAfterMs` after posting; until
// then task_get answers 40602 "Task In Queue." like the real API. Results
// hold a full SERP (competitors plus, usually, the client's own page), so
// the target filtering in targetMatch.js is exercised the same way as with
// real Standard responses.

import { randomUUID } from "node:crypto";
import type { StandardClient, StandardTaskPayload } from "./standardClient.js";

interface MockTask {
  id: string;
  payload: StandardTaskPayload;
  readyAt: number;
  collected: boolean;
}

function pseudoRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash / 0xffffffff;
}

function serpFor(payload: StandardTaskPayload) {
  const r = pseudoRandom(payload.keyword);
  const clientHost = payload.stop_crawl_on_match?.[0]?.match_value ?? "client-site.example";
  const clientRank = r < 0.15 ? null : Math.max(1, Math.round(r * 100));
  const items = [];
  for (let rank = 1; rank <= 100; rank++) {
    const own = rank === clientRank;
    const host = own ? `www.${clientHost}` : `competitor-${rank}.example`;
    items.push({ type: "organic", rank_group: rank, rank_absolute: rank, domain: host, url: `https://${host}/${own ? "" : "page"}`, title: `Mock result ${rank}` });
    if (own) break; // stop_crawl_on_match: the crawl ends at the client's page
  }
  return { keyword: payload.keyword, se_domain: payload.se_domain, pages_count: clientRank ? Math.ceil(clientRank / 10) : 10, items_count: items.length, items };
}

export function createMockStandardClient({ readyAfterMs = 5_000, now = () => Date.now() } = {}): StandardClient & { tasks: Map<string, MockTask> } {
  const tasks = new Map<string, MockTask>();
  const envelope = (taskEntries: unknown[]) => ({ status_code: 20000, status_message: "Ok.", tasks_count: taskEntries.length, tasks_error: 0, tasks: taskEntries });

  return {
    tasks,
    async postTasks(payloads) {
      const entries = payloads.map((payload) => {
        const id = randomUUID();
        tasks.set(id, { id, payload, readyAt: now() + readyAfterMs, collected: false });
        return { id, status_code: 20100, status_message: "Task Created.", data: { ...payload }, result: null };
      });
      return { httpStatus: 200, body: envelope(entries) };
    },
    async tasksReady() {
      const ready = [...tasks.values()].filter((t) => !t.collected && t.readyAt <= now()).map((t) => ({ id: t.id, tag: t.payload.tag }));
      return { httpStatus: 200, body: envelope([{ id: "tasks-ready", status_code: 20000, status_message: "Ok.", result_count: ready.length, result: ready }]) };
    },
    async taskGet(id) {
      const task = tasks.get(id);
      if (!task) return { httpStatus: 200, body: envelope([{ id, status_code: 40401, status_message: "Task Not Found.", result: null }]) };
      if (task.readyAt > now()) return { httpStatus: 200, body: envelope([{ id, status_code: 40602, status_message: "Task In Queue.", result: null }]) };
      task.collected = true;
      return { httpStatus: 200, body: envelope([{ id, status_code: 20000, status_message: "Ok.", data: { ...task.payload }, result: [serpFor(task.payload)] }]) };
    },
  };
}
