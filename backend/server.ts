import path from 'node:path';
import { createApp } from './api/app.js';
import { callDataForSeoLive, LIVE_ENDPOINT_URL } from './dataforseo/client.js';
import { createMockDataForSeoClient } from './dataforseo/mockClient.js';
import { createMockEmailSender } from './reporting/mockEmailSender.js';
import { createClickUpEmailSender, verifyChromiumLaunch } from './reporting/clickupEmailSender.js';
import { generateExcelPdfAttachment } from './reporting/generateExcelAttachment.js';

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
const sendEmail = useClickUp
  ? createClickUpEmailSender({
      sessionStatePath: process.env.CLICKUP_SESSION_PATH ?? path.resolve('spikes/clickup-feasibility/session/clickup-storage-state.json'),
    })
  : createMockEmailSender();

if (useClickUp) {
  console.log('Report delivery: LIVE via ClickUp -- approved reports will be sent through the ClickUp Email composer.');
} else {
  console.log('Report delivery: MOCK mode (default). Set CLICKUP_EMAIL_LIVE=true to send through ClickUp for real.');
}

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

  const app = createApp(callDataForSeo, useLive ? 'live' : 'mock', useLive ? LIVE_ENDPOINT_URL : undefined, {
    sendEmail,
    generateExcelAttachment: generateExcelPdfAttachment,
  });
  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
}

start();
