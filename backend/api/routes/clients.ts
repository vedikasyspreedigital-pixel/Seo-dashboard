import { Router } from 'express';
import { prisma } from '../../db/client.js';

export const clientsRouter = Router();

clientsRouter.get('/', async (_req, res) => {
  const clients = await prisma.client.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json(clients);
});
