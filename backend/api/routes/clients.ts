import { Router, type Request, type Response } from 'express';
import { prisma } from '../../db/client.js';
import { requireAuth } from '../../auth/requireAuth.js';

export const clientsRouter = Router();

clientsRouter.use(requireAuth);

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

function flattenClient<T extends { id: string; reportConfigs?: { clickupTaskId: string | null; clickupTaskUrl: string | null }[] }>(client: T) {
  const { reportConfigs, ...rest } = client;
  const config = reportConfigs?.[0];
  return { ...rest, clickupTaskId: config?.clickupTaskId ?? null, clickupTaskUrl: config?.clickupTaskUrl ?? null };
}

/** 404s (never leaks 403 across workspaces) unless the client belongs to one of the caller's workspaces. Returns the client row on success. */
async function findOwnedClientOrRespond(req: Request, res: Response, id: string) {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client || !client.workspaceId || !req.authUser!.workspaceIds.includes(client.workspaceId)) {
    res.status(404).json({ error: 'Client not found' });
    return null;
  }
  return client;
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
    include: { reportConfigs: { where: { isActive: true }, take: 1 } },
  });
  res.json(clients.map(flattenClient));
});

clientsRouter.post('/', async (req, res) => {
  const { workspaceId, name, clickupTaskId, clickupTaskUrl, notes } = req.body ?? {};
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

  const client = await prisma.client.create({
    data: {
      name: name.trim(),
      workspaceId,
      notes: typeof notes === 'string' && notes.trim().length > 0 ? notes.trim() : null,
      ...((typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0) || (typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0)
        ? {
            reportConfigs: {
              create: {
                ...DEFAULT_REPORT_CONFIG,
                clickupTaskId: typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0 ? clickupTaskId.trim() : null,
                clickupTaskUrl: typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0 ? clickupTaskUrl.trim() : null,
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

  const { name, notes, clickupTaskId, clickupTaskUrl } = req.body ?? {};
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }

  await prisma.client.update({
    where: { id: client.id },
    data: {
      ...(name !== undefined ? { name: (name as string).trim() } : {}),
      ...(notes !== undefined ? { notes: typeof notes === 'string' && notes.trim().length > 0 ? notes.trim() : null } : {}),
    },
  });

  if (clickupTaskId !== undefined || clickupTaskUrl !== undefined) {
    const currentConfig = await prisma.clientReportConfig.findFirst({ where: { clientId: client.id, isActive: true } });
    const clickupData = {
      ...(clickupTaskId !== undefined ? { clickupTaskId: typeof clickupTaskId === 'string' && clickupTaskId.trim().length > 0 ? clickupTaskId.trim() : null } : {}),
      ...(clickupTaskUrl !== undefined ? { clickupTaskUrl: typeof clickupTaskUrl === 'string' && clickupTaskUrl.trim().length > 0 ? clickupTaskUrl.trim() : null } : {}),
    };
    if (currentConfig) {
      await prisma.clientReportConfig.update({ where: { id: currentConfig.id }, data: clickupData });
    } else {
      await prisma.clientReportConfig.create({ data: { clientId: client.id, ...DEFAULT_REPORT_CONFIG, ...clickupData } });
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
