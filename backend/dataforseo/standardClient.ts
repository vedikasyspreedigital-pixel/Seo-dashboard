// DataForSEO Standard (queue) method for Google Organic SERP -- the
// alternative to callDataForSeoLive (client.ts) for workspaces switched to
// "standard" (see engine.ts). Lifecycle, from DataForSEO's v3 docs and the
// free sandbox (2026-10-30):
//   POST task_post            up to 100 tasks per call; each task answers
//                             20100 "Task Created." with its id, or its own
//                             error (e.g. 40501 "Invalid Field") -- one bad
//                             task never fails the batch. `tag` is echoed in
//                             tasks[i].data.tag.
//   GET  tasks_ready          finished, not-yet-collected tasks (up to 1000,
//                             max 20 calls/min, listed for 3 days).
//   GET  task_get/regular/id  the result (free, kept 30 days); 40602 "Task In
//                             Queue" / 40601 "Task Handed" while not done.
// Every call returns { httpStatus, body } or { transportError } like
// callDataForSeoLive, never throws for an HTTP or network failure.

import type { DataForSeoCallResult } from "./client.js";

export const STANDARD_BASE_URL = "https://api.dataforseo.com/v3/serp/google/organic";
/** Most tasks task_post accepts in one call (more -> 40006). */
export const MAX_TASKS_PER_POST = 100;

/** One task_post entry: the Live payload minus `target` (Standard has none), plus our tag and priority. */
export interface StandardTaskPayload {
  keyword: string;
  location_name: string;
  se_domain: string;
  language_name: string;
  device: string;
  os: string;
  depth: number;
  stop_crawl_on_match?: { match_type: string; match_value: string }[];
  find_targets_in?: string[];
  tag: string;
  priority: 1 | 2;
}

export interface StandardClient {
  postTasks(tasks: StandardTaskPayload[]): Promise<DataForSeoCallResult>;
  tasksReady(): Promise<DataForSeoCallResult>;
  taskGet(dataforseoTaskId: string): Promise<DataForSeoCallResult>;
}

const REQUEST_TIMEOUT_MS = 60_000;

export function createStandardClient({
  baseUrl = process.env.DATAFORSEO_STANDARD_BASE_URL || STANDARD_BASE_URL,
  fetchImpl = fetch,
}: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): StandardClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<DataForSeoCallResult> {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    if (!login || !password) throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { httpStatus: response.status, body: await response.json() };
    } catch (transportError) {
      return { transportError: transportError as Error };
    }
  }

  return {
    postTasks: (tasks) => call("POST", "/task_post", tasks),
    tasksReady: () => call("GET", "/tasks_ready"),
    taskGet: (id) => call("GET", `/task_get/regular/${encodeURIComponent(id)}`),
  };
}
