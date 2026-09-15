import { Router, type Request, type Response } from 'express';
import { prisma } from '../../db/client.js';
import { requireAuth } from '../../auth/requireAuth.js';
import { findOwnedClientOrRespond } from '../../auth/ownership.js';

export const clientsRouter = Router();

clientsRouter.use(requireAuth);

// Mirrors reports.ts's EMAIL_PATTERN exactly -- same validation rule
// wherever an email address is accepted from a client request body.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailListField(value: unknown, fieldName: string): { ok: true; emails: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: `${fieldName} must be an array of email addresses` };
  const invalid = value.filter((v: unknown) => typeof v !== 'string' || !EMAIL_PATTERN.test(v));
  if (invalid.length > 0) return { ok: false, error: `${fieldName} contains invalid email address(es): ${invalid.join(', ')}` };
  return { ok: true, emails: value as string[] };
}

// Defaults mirrored from scripts/import-workspace-clients.mjs so a client
// created here has the same shape as one created by the bulk importer --
// recipients starts empty deliberately (NO_RECIPIENTS blocks a send until a
// human adds at least one, same as the importer's own comment).
const DEFAULT_REPORT_CONFIG = {
  reportTone: 'professional',
  sectionsEnabled: ['summary'],
  metricsEnabled: ['averageRank', 'top3', 'top10', 'notIn100'],
  recipients: [],
  reportingFrequency: 'manual',
  templateId: 'standard-v1',
};

function flattenClient<
  T extends {
    id: string;
    reportConfigs?: { clickupTaskId: string | null; clickupTaskUrl: string | null; recipients: unknown; cc: unknown }[];
    baselines?: { baselineDate: Date; createdAt: Date }[];
  },
>(client: T) {
  const { reportConfigs, baselines, ...rest } = client;
  const config = reportConfigs?.[0];
  const latest = baselines?.[0];
  return {
    ...rest,
    clickupTaskId: config?.clickupTaskId ?? null,
    clickupTaskUrl: config?.clickupTaskUrl ?? null,
    // The client's default email To/Cc -- auto-populated into every new
    // report's email draft by generateEmailDraft.ts, editable per-report
    // afterward. Empty array (not null) when the client has no config yet.
    recipients: Array.isArray(config?.recipients) ? (config.recipients as string[]) : [],
    cc: Array.isArray(config?.cc) ? (config.cc as string[]) : [],
    latestBaseline: latest ? { baselineDate: latest.baselineDate, uploadedAt: latest.createdAt } : null,
  };
}

// Scoped to the workspace the caller explicitly asks for (mirrors the
// existing clientId-as-query-param pattern already used by runs.ts/
// reports.ts), validated against req.authUser.workspaceIds so a user can
// never list a workspace they don't have a WorkspaceMembership row for.
// Test/mock clients (isTestData) and clients not yet triaged into any
// workspace (workspaceId: null) never appear here.
//
// includeInactive=true / includeArchived=true are additive, opt-in query
// params used only by Client Management -- called with neither, this
// endpoint's behavior (and response shape) is byte-identical to before, so
// the Header's client dropdown is unaffected.
clientsRouter.get('/', async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    res.status(400).json({ error: 'workspaceId query parameter is required' });
    return;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: 'You do not have access to this workspace' });
    return;
  }

  const includeInactive = req.query.includeInactive === 'true';
  const includeArchived = req.query.includeArchived === 'true';

  if (!includeInactive) {
    const clients = await prisma.client.findMany({
      where: { isActive: true, isTestData: false, workspaceId },
      orderBy: { name: 'asc' },
    });
    res.json(clients);
    return;
  }

  const clients = await prisma.client.findMany({
    where: { isTestData: false, workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { name: 'asc' },
    include: {
      reportConfigs: { where: { isActive: true }, take: 1 },
      // Most recent baseline only -- Client Management shows upload status
      // per client (badge + date), not the full history (that's what
      // GET /clients/:id/baselines is for).
      baselines: { orderBy: { createdAt: 'desc' }, take: 1, select: { baselineDate: true, createdAt: true } },
    },
  });
  res.json(clients.map(flattenClient));
});

clientsRouter.post('/', async (req, res) => {
  const { workspaceId, name, domain, clickupTaskId, clickupTaskUrl, notes, recipients, cc } = req.body ?? {};
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: 'You do not have access to this workspace' });
    return;
  }

  let recipientEmails: string[] = [];
  if (recipients !== undefined) {
    const parsed = parseEmailListField(recipients, 'recipients');
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    recipientEmails = parsed.emails;
  }
  let ccEmails: string[] = [];
  if (cc !== undefined) {
    const parsed = parseEmailListField(cc, 'cc');
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    ccEmails = parsed.emails;
  }

  const hasClickup = (typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0) || (typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0);
  const hasEmailFields = recipientEmails.length > 0 || ccEmails.length > 0;

  const client = await prisma.client.create({
    data: {
      name: name.trim(),
      workspaceId,
      notes: typeof notes === 'string' && notes.trim().length > 0 ? notes.trim() : null,
      domain: typeof domain === 'string' && domain.trim().length > 0 ? domain.trim() : null,
      ...(hasClickup || hasEmailFields
        ? {
            reportConfigs: {
              create: {
                ...DEFAULT_REPORT_CONFIG,
                clickupTaskId: typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0 ? clickupTaskId.trim() : null,
                clickupTaskUrl: typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0 ? clickupTaskUrl.trim() : null,
                recipients: recipientEmails,
                cc: ccEmails,
              },
            },
          }
        : {}),
    },
    include: { reportConfigs: { where: { isActive: true }, take: 1 } },
  });
  res.status(201).json(flattenClient(client));
});

clientsRouter.patch('/:id', async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;

  const { name, notes, domain, clickupTaskId, clickupTaskUrl, recipients, cc } = req.body ?? {};
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  let recipientEmails: string[] | undefined;
  if (recipients !== undefined) {
    const parsed = parseEmailListField(recipients, 'recipients');
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    recipientEmails = parsed.emails;
  }
  let ccEmails: string[] | undefined;
  if (cc !== undefined) {
    const parsed = parseEmailListField(cc, 'cc');
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    ccEmails = parsed.emails;
  }

  await prisma.client.update({
    where: { id: client.id },
    data: {
      ...(name !== undefined ? { name: (name as string).trim() } : {}),
      ...(notes !== undefined ? { notes: typeof notes === 'string' && notes.trim().length > 0 ? notes.trim() : null } : {}),
      ...(domain !== undefined ? { domain: typeof domain === 'string' && domain.trim().length > 0 ? domain.trim() : null } : {}),
    },
  });

  if (clickupTaskId !== undefined || clickupTaskUrl !== undefined || recipientEmails !== undefined || ccEmails !== undefined) {
    const currentConfig = await prisma.clientReportConfig.findFirst({ where: { clientId: client.id, isActive: true } });
    const configData = {
      ...(clickupTaskId !== undefined ? { clickupTaskId: typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0 ? clickupTaskId.trim() : null } : {}),
      ...(clickupTaskUrl !== undefined ? { clickupTaskUrl: typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0 ? clickupTaskUrl.trim() : null } : {}),
      ...(recipientEmails !== undefined ? { recipients: recipientEmails } : {}),
      ...(ccEmails !== undefined ? { cc: ccEmails } : {}),
    };
    if (currentConfig) {
      await prisma.clientReportConfig.update({ where: { id: currentConfig.id }, data: configData });
    } else {
      await prisma.clientReportConfig.create({ data: { clientId: client.id, ...DEFAULT_REPORT_CONFIG, ...configData } });
    }
  }

  const updated = await prisma.client.findUniqueOrThrow({
    where: { id: client.id },
    include: { reportConfigs: { where: { isActive: true }, take: 1 } },
  });
  res.json(flattenClient(updated));
});

async function setClientFlags(req: Request, res: Response, data: { isActive?: boolean; archivedAt?: Date | null }) {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;
  const updated = await prisma.client.update({ where: { id: client.id }, data });
  res.json(updated);
}

clientsRouter.patch('/:id/activate', (req, res) => setClientFlags(req, res, { isActive: true }));
clientsRouter.patch('/:id/deactivate', (req, res) => setClientFlags(req, res, { isActive: false }));
// "Delete" -- always a soft archive, never a hard row delete: Client's FKs
// into RankingRun/ClientReportConfig/RankingReport are ON DELETE RESTRICT,
// so a real delete would fail for any client with history anyway. Archiving
// also deactivates, so every existing "isActive: true" query (the dropdown,
// overview counts) excludes archived clients with no extra clause needed.
clientsRouter.patch('/:id/archive', (req, res) => setClientFlags(req, res, { archivedAt: new Date(), isActive: false }));
// Restoring only clears archivedAt -- isActive stays false so a restored
// client doesn't silently reappear in run/client dropdowns; re-activating is
// a separate, deliberate action taken from Client Management.
clientsRouter.patch('/:id/restore', (req, res) => setClientFlags(req, res, { archivedAt: null }));
