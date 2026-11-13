import { prisma } from '../db/client.js';
import { processRun, type CallDataForSeoFn } from '../worker/processRun.js';
import { wakeStandardQueue } from '../worker/standardQueue.js';

// Which DataForSEO method checks a run's rows. "live" (Live API, processRun.ts)
// stays the default for every workspace; a workspace moves to "standard"
// (Standard queue, standardQueue.ts) only when its slug is listed in
// DATAFORSEO_STANDARD_WORKSPACES, e.g. "advanced-seo" or "advanced-seo,seo".
// Removing it switches back. The choice is saved on the run when it is
// started or rerun, so a run never changes method halfway, and restart
// recovery knows which worker owns it.

export type RankingEngine = 'live' | 'standard' | 'serper';

export function standardWorkspaceSlugs(): Set<string> {
  return new Set(
    (process.env.DATAFORSEO_STANDARD_WORKSPACES ?? '')
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
  );
}

export async function assignEngine(runId: string): Promise<RankingEngine> {
  const run = await prisma.rankingRun.findUniqueOrThrow({
    where: { id: runId },
    select: { client: { select: { workspace: { select: { slug: true } } } } },
  });
  const engine: RankingEngine = standardWorkspaceSlugs().has(run.client.workspace?.slug ?? '')
    ? 'standard'
    : process.env.DATAFORSEO_LIVE === 'true' && process.env.RANK_PROVIDER?.trim().toLowerCase() === 'serper'
      ? 'serper' // checked one row at a time like Live (processRun), with the Serper call
      : 'live';
  await prisma.rankingRun.update({ where: { id: runId }, data: { engine } });
  return engine;
}

/**
 * Starts checking a run that was just started or reopened ("Rerun failed").
 * Live: fire-and-forget processRun, exactly as before. Standard: the rows are
 * already PENDING in the database, so waking the queue is all it takes.
 */
export async function startRunProcessing(runId: string, callDataForSeo: CallDataForSeoFn, label = ''): Promise<RankingEngine> {
  const engine = await assignEngine(runId);
  if (engine === 'standard') {
    wakeStandardQueue();
    return engine;
  }
  processRun(runId, callDataForSeo).catch((err) => {
    console.error(`processRun failed for run ${runId}${label}:`, err);
  });
  return engine;
}
