import { randomUUID } from "node:crypto";
import { FetchError, type FetchExportFn, type FetchedExport } from "./fetchers/flikoverAhrefs.js";
import type { KeywordSource } from "./readKeywordExport.js";

// Domain Intelligence: the "office Chrome agent" (user's decision, 2026-10-21).
// Our own Chrome extension (extension/ in this repo) runs inside a normal
// Chrome on one office computer where someone is signed in to Flikover /
// seotooladda. It polls this queue, does the export IN THAT REAL BROWSER, and
// uploads the file back. A "verify you are human" check is never bypassed: the
// extension reports it, the job waits, a person ticks it, the job continues.
//
// To the rest of the app an agent task is just another FetchExportFn
// (createAgentFetcher), so fetchJob.ts / "Combine and post" are unchanged.
// Tasks live in memory: a restart fails the waiting fetch, which the page
// then offers to retry.

export type AgentTaskState = "pending" | "claimed" | "needs_human";

/** The flows the extension knows: keyword exports, report PDFs, and Semrush's competitor list. */
export type AgentTool = KeywordSource | "siteaudit" | "woorank" | "competitors";

export interface AgentTask {
  id: string;
  /** The flow the extension runs, e.g. "ahrefs". */
  tool: AgentTool;
  domain: string;
  location: string | null;
  state: AgentTaskState;
  step?: string;
  createdAt: number;
  claimedAt?: number;
  lastProgressAt?: number;
}

interface Waiting {
  task: AgentTask;
  onStep?: (step: string) => void;
  resolve: (result: FetchedExport) => void;
  reject: (err: Error) => void;
}

/** Nobody picked the job up in this long -> the office computer/Chrome is off. */
export const UNCLAIMED_TIMEOUT_MS = 2 * 60 * 1000;
/** A claimed job that reports nothing for this long is given up (a "verify human" wait has its own, longer limit). */
export const STALLED_TIMEOUT_MS = 4 * 60 * 1000;
export const NEEDS_HUMAN_TIMEOUT_MS = 15 * 60 * 1000;
/** The agent counts as online if it asked for work within this window (it polls every ~30s). */
const ONLINE_WINDOW_MS = 90 * 1000;

const waiting = new Map<string, Waiting>();
let lastSeenAt = 0;
let lastSeenVersion: string | null = null;

function finish(id: string, outcome: { result?: FetchedExport; error?: Error }) {
  const w = waiting.get(id);
  if (!w) return false;
  waiting.delete(id);
  if (outcome.error) w.reject(outcome.error);
  else w.resolve(outcome.result!);
  return true;
}

/** Fails tasks nobody is working on any more -- called whenever the queue is touched. */
export function expireStale(now = Date.now()) {
  // The agent does one job at a time: a job queued behind a working one (WooRank behind an 8-10 minute Site
  // Audit) isn't "unclaimed" -- it used to fail after 2 minutes with "didn't pick up the job" (2026-10-28).
  // So the 2 minutes count only while the agent is free, from when it last showed up (polled or reported).
  const agentBusy = [...waiting.values()].some(({ task }) => task.state === "claimed" || task.state === "needs_human");
  for (const { task } of waiting.values()) {
    if (task.state === "pending" && !agentBusy && now - Math.max(task.createdAt, lastSeenAt) > UNCLAIMED_TIMEOUT_MS) {
      finish(task.id, { error: new FetchError("AGENT_OFFLINE", "The office Chrome agent didn't pick up the job -- is that computer on, with Chrome open and the SERP Console extension running?") });
    } else if (task.state === "claimed" && now - (task.lastProgressAt ?? task.claimedAt ?? now) > STALLED_TIMEOUT_MS) {
      finish(task.id, { error: new FetchError("TIMEOUT", `The office Chrome agent stopped responding${task.step ? ` at "${task.step}"` : ""}.`) });
    } else if (task.state === "needs_human" && now - (task.lastProgressAt ?? now) > NEEDS_HUMAN_TIMEOUT_MS) {
      finish(task.id, { error: new FetchError("BOT_CHECK", "Nobody ticked \"verify you are human\" on the office computer within 15 minutes.") });
    }
  }
}

// Expiry also has to happen when the agent is off and never polls.
let sweeper: NodeJS.Timeout | null = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    expireStale();
    if (waiting.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 15_000);
  sweeper.unref();
}

/** A FetchExportFn whose work is done by the extension. */
export function createAgentFetcher(tool: AgentTool): FetchExportFn {
  return ({ domain, location, onStep }) =>
    new Promise<FetchedExport>((resolve, reject) => {
      ensureSweeper();
      const task: AgentTask = { id: randomUUID(), tool, domain, location, state: "pending", createdAt: Date.now() };
      waiting.set(task.id, { task, onStep, resolve, reject });
      onStep?.("Waiting for the office Chrome agent");
    });
}

/** Extension: the oldest pending task (or none). Also records that the agent is alive. */
export function claimNext(agentVersion: string | null): AgentTask | null {
  lastSeenAt = Date.now();
  lastSeenVersion = agentVersion;
  expireStale();
  const next = [...waiting.values()].map((w) => w.task).filter((t) => t.state === "pending").sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return null;
  next.state = "claimed";
  next.claimedAt = next.lastProgressAt = Date.now();
  waiting.get(next.id)?.onStep?.("Office Chrome agent started");
  return next;
}

export class AgentTaskGone extends Error {}

function claimed(id: string): Waiting {
  const w = waiting.get(id);
  if (!w || w.task.state === "pending") throw new AgentTaskGone("This job is no longer running (finished, timed out or cancelled).");
  return w;
}

/** Extension: progress. needsHuman = a "verify you are human" check is showing and a person must tick it. */
export function reportProgress(id: string, step: string, needsHuman = false) {
  const w = claimed(id);
  lastSeenAt = Date.now(); // busy with a job counts as online
  w.task.state = needsHuman ? "needs_human" : "claimed";
  w.task.step = step;
  w.task.lastProgressAt = Date.now();
  w.onStep?.(needsHuman ? `Waiting for someone to tick "verify you are human" on the office computer (${step})` : step);
}

export function completeTask(id: string, result: FetchedExport) {
  claimed(id);
  finish(id, { result });
}

const AGENT_CODES = ["SESSION_EXPIRED", "MULTIPLE_SESSIONS", "BOT_CHECK", "NO_DATA", "TIMEOUT", "FAILED"] as const;

export function failTask(id: string, code: string, message: string) {
  claimed(id);
  const safeCode = (AGENT_CODES as readonly string[]).includes(code) ? (code as (typeof AGENT_CODES)[number]) : "FAILED";
  finish(id, { error: new FetchError(safeCode, message.slice(0, 500) || "The office Chrome agent reported a failure.") });
}

export function agentStatus() {
  expireStale();
  return { online: Date.now() - lastSeenAt < ONLINE_WINDOW_MS, lastSeenAt: lastSeenAt || null, version: lastSeenVersion, waiting: waiting.size };
}

/** Tests only. */
export function resetAgentQueue() {
  for (const id of [...waiting.keys()]) finish(id, { error: new Error("reset") });
  lastSeenAt = 0;
  lastSeenVersion = null;
}
