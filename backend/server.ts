import path from 'node:path';
import { createApp } from './api/app.js';
import { callDataForSeoLive, LIVE_ENDPOINT_URL } from './dataforseo/client.js';
import { createMockDataForSeoClient } from './dataforseo/mockClient.js';
import { createMockEmailSender } from './reporting/mockEmailSender.js';
import { createClickUpEmailSender, verifyChromiumLaunch } from './reporting/clickupEmailSender.js';
import { generateExcelPdfAttachment } from './reporting/generateExcelAttachment.js';
import { recoverStaleProcessingRows } from './worker/recoverStaleRuns.js';
import { createClickUpCommentPoster, createMockCommentPoster } from './domainIntel/clickupCommentPoster.js';
import { createFlikoverAhrefsFetcher, createMockAhrefsFetcher } from './domainIntel/fetchers/flikoverAhrefs.js';
import { aiProviderName } from './domainIntel/classifyIntent.js';
import { createGeminiAuditWriter } from './domainIntel/aiSeoAudit.js';
import { loadSavedAudits } from './domainIntel/auditJob.js';
import { createGeminiGapAdvisor } from './domainIntel/gapReport.js';
import { agentStatus, createAgentFetcher } from './domainIntel/agentQueue.js';
import { access } from 'node:fs/promises';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env optional if vars are already set
  }
}

// Without these, a truly unhandled error (outside any request -- e.g. a
// rejected promise nothing ever awaited) crashes the process with no trace
// beyond Node's own default stderr dump, and on some platforms no trace at
// all. Logs and keeps running rather than exiting, since a single bad
// rejection elsewhere in the process is not a reason to drop every
// in-flight request.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

const PORT = Number(process.env.PORT ?? 3001);

// Safety default: MOCK unless DATAFORSEO_LIVE=true is explicitly set.
// This is the actual gate on real API calls/spend, not just a convention.
const useLive = process.env.DATAFORSEO_LIVE === 'true';
const callDataForSeo = useLive ? callDataForSeoLive : createMockDataForSeoClient();

if (useLive) {
  console.log('DataForSEO: LIVE mode -- real API calls will be made and billed.');
} else {
  console.log('DataForSEO: MOCK mode (default). Set DATAFORSEO_LIVE=true to enable real calls.');
}

// Same safety gate as DataForSEO above, for report delivery: MOCK unless
// CLICKUP_EMAIL_LIVE=true is explicitly set. Requires the one-time manual
// login (spikes/clickup-feasibility/setupSession.mjs) to already have
// produced a session file at CLICKUP_SESSION_PATH -- this does not log in
// on its own, and never will.
const useClickUp = process.env.CLICKUP_EMAIL_LIVE === 'true';

// Per-workspace ClickUp session override: a workspace with its own
// dedicated ClickUp account/login gets its own entry here (one env var
// each, named CLICKUP_SESSION_PATH_<SLUG>), produced by running
// setupSession.mjs a second time against that workspace's own ClickUp
// login (see the README's Deploy section). Any workspace NOT listed here -- "seo"
// today -- keeps using the single shared CLICKUP_SESSION_PATH below,
// completely unchanged. Purely additive: unset by default.
const sessionStatePathByWorkspace: Record<string, string> = {};
if (process.env.CLICKUP_SESSION_PATH_ADVANCED_SEO) {
  sessionStatePathByWorkspace['advanced-seo'] = process.env.CLICKUP_SESSION_PATH_ADVANCED_SEO;
}

const sendEmail = useClickUp
  ? createClickUpEmailSender({
      sessionStatePath: process.env.CLICKUP_SESSION_PATH ?? path.resolve('spikes/clickup-feasibility/session/clickup-storage-state.json'),
      sessionStatePathByWorkspace,
    })
  : createMockEmailSender();

if (useClickUp) {
  console.log('Report delivery: LIVE via ClickUp -- approved reports will be sent through the ClickUp Email composer.');
  console.log(
    Object.keys(sessionStatePathByWorkspace).length > 0
      ? `ClickUp: per-workspace sessions configured for: ${Object.keys(sessionStatePathByWorkspace).join(', ')} (everything else uses the shared default session).`
      : 'ClickUp: no per-workspace sessions configured -- every workspace uses the shared default session.',
  );
} else {
  console.log('Report delivery: MOCK mode (default). Set CLICKUP_EMAIL_LIVE=true to send through ClickUp for real.');
}

// Domain Intelligence posts its reports as ClickUp COMMENTS -- a different
// composer flow from the email sender above, not yet confirmed against real
// ClickUp, so it has its own gate: MOCK unless CLICKUP_COMMENTS_LIVE=true.
// Uses the same saved session(s) as the email sender.
const useClickUpComments = process.env.CLICKUP_COMMENTS_LIVE === 'true';
const postComment = useClickUpComments
  ? createClickUpCommentPoster({
      sessionStatePath: process.env.CLICKUP_SESSION_PATH ?? path.resolve('spikes/clickup-feasibility/session/clickup-storage-state.json'),
      sessionStatePathByWorkspace,
    })
  : createMockCommentPoster();
console.log(
  useClickUpComments
    ? 'Domain Intelligence: LIVE -- reports are posted as comments on each client\'s domain-report ClickUp task.'
    : 'Domain Intelligence: MOCK posting (default). Set CLICKUP_COMMENTS_LIVE=true to post to ClickUp for real.',
);
// Domain Intelligence fetching, by DOMAIN_INTEL_FETCH_MODE:
//  - "agent": the office Chrome extension (extension/) does the export in a
//    real, signed-in Chrome; needs DOMAIN_INTEL_AGENT_TOKEN (user's choice, 2026-10-21).
//  - "playwright" (or legacy DOMAIN_INTEL_FETCH_LIVE=true): this server drives
//    a VISIBLE browser with a saved Flikover login.
//  - "mock" (default): no tool is contacted.
const fetchMode =
  process.env.DOMAIN_INTEL_FETCH_MODE === 'agent' || process.env.DOMAIN_INTEL_FETCH_MODE === 'playwright'
    ? process.env.DOMAIN_INTEL_FETCH_MODE
    : process.env.DOMAIN_INTEL_FETCH_LIVE === 'true'
      ? 'playwright'
      : 'mock';
if (fetchMode === 'agent' && !process.env.DOMAIN_INTEL_AGENT_TOKEN) {
  console.error('Domain Intelligence: DOMAIN_INTEL_FETCH_MODE=agent but DOMAIN_INTEL_AGENT_TOKEN is not set -- the extension cannot connect.');
}
const flikoverSessionPath = process.env.FLIKOVER_SESSION_PATH ?? path.resolve('spikes/domain-intel-fetch/session/flikover-storage-state.json');
// Ahrefs can stay on the server's Playwright robot (Flikover) even in agent mode:
// DOMAIN_INTEL_AHREFS_VIA=playwright. Semrush/Ubersuggest (seotooladda, behind
// Cloudflare) only work through the agent's real Chrome.
const ahrefsVia = fetchMode === 'agent' && process.env.DOMAIN_INTEL_AHREFS_VIA !== 'playwright' ? 'agent' : fetchMode;
const domainIntelFetchers = {
  ahrefs:
    ahrefsVia === 'agent'
      ? createAgentFetcher('ahrefs')
      : ahrefsVia === 'playwright'
        ? createFlikoverAhrefsFetcher({ sessionPath: flikoverSessionPath, debugDir: process.env.DOMAIN_INTEL_DEBUG_DIR })
        : createMockAhrefsFetcher({ mockFilePath: process.env.DOMAIN_INTEL_MOCK_AHREFS_FILE }),
  ...(fetchMode === 'agent' ? { semrush: createAgentFetcher('semrush'), ubersuggest: createAgentFetcher('ubersuggest') } : {}),
};
const domainIntelFetchInfo = async () => ({
  live: fetchMode !== 'mock',
  mode: fetchMode,
  // "agent": the extension asked for work recently; "playwright": a login file is saved.
  sessionSaved: fetchMode === 'agent' ? agentStatus().online : await access(flikoverSessionPath).then(() => true, () => false),
  agent: fetchMode === 'agent' ? agentStatus() : null,
});
console.log(
  fetchMode === 'agent'
    ? 'Domain Intelligence: AGENT fetching -- the office Chrome extension exports from the tools.'
    : fetchMode === 'playwright'
      ? 'Domain Intelligence: LIVE fetching -- Ahrefs via Flikover with the saved login (Playwright).'
      : 'Domain Intelligence: MOCK fetching (default). Set DOMAIN_INTEL_FETCH_MODE=agent (or playwright) to fetch for real.',
);
console.log(
  aiProviderName()
    ? `Domain Intelligence: keyword intent uses patterns, then ${aiProviderName()} for unclear keywords.`
    : 'Domain Intelligence: no GEMINI_API_KEY / ANTHROPIC_API_KEY -- keyword intent uses patterns and the tools\' labels only.',
);

async function start() {
  // Deploy-time environment check, not part of the send flow -- proves
  // Chromium can actually launch in THIS environment before any real user
  // clicks Approve & Send. Born from a real outage where Chromium failed
  // to launch on Railway (missing OS libraries the build never persisted
  // into the runtime image -- see nixpacks.toml) and that only surfaced
  // when a real report failed to send. Logged, never blocks startup --
  // ClickUp being broken shouldn't take down report generation, uploads,
  // or anything else the app does.
  if (useClickUp) {
    const check = await verifyChromiumLaunch();
    if (check.ok) {
      console.log(`Chromium startup check: OK -- ${check.message}`);
    } else {
      console.error(`Chromium startup check: FAILED -- ${check.message} -- ClickUp sends will fail until this is fixed.`);
    }
  }

  // Recovers any run left stuck PROCESSING by the previous process (crash,
  // OOM kill, manual restart, or a hung request killed along with it) --
  // awaited here so the DB is already consistent before the server starts
  // accepting requests; the actual resumed DataForSEO calls run in the
  // background and don't block startup.
  await recoverStaleProcessingRows(callDataForSeo);
  await loadSavedAudits();

  const app = createApp(callDataForSeo, useLive ? 'live' : 'mock', useLive ? LIVE_ENDPOINT_URL : undefined, {
    sendEmail,
    generateExcelAttachment: generateExcelPdfAttachment,
  }, {
    postComment,
    fetchers: domainIntelFetchers,
    fetchInfo: domainIntelFetchInfo,
    // Report PDFs only exist through the office Chrome agent.
    auditFetchers: fetchMode === 'agent' ? { siteaudit: createAgentFetcher('siteaudit'), woorank: createAgentFetcher('woorank') } : {},
    competitorFetcher: fetchMode === 'agent' ? createAgentFetcher('competitors') : undefined,
    gapAdvisor: process.env.GEMINI_API_KEY ? createGeminiGapAdvisor(process.env.GEMINI_API_KEY) : null,
    aiAuditWriter: process.env.GEMINI_API_KEY ? createGeminiAuditWriter(process.env.GEMINI_API_KEY) : null,
  });
  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
}

start();
