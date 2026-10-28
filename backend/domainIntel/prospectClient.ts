import { prisma } from "../db/client.js";
import { bareDomain } from "./fetchers/flikoverAhrefs.js";

// Domain Intelligence is run for a NEW client almost every time (user, 2026-10-28), so the page takes a typed
// client name + ClickUp task instead of a client picked from the list. Behind it is still a normal Client row
// (reports, audits and access checks all hang off one) -- kind "domain", hidden from the ranking side's lists.
// Typing the same name again reuses that row and updates its website and task.

export class ProspectClientError extends Error {}

/**
 * A ClickUp task id from what the team pasted: the bare id ("86c1abcde") or a task link
 * ("https://app.clickup.com/t/86c1abcde", also "/t/<team id>/<custom id>"). "" = none (download only).
 */
export function toClickUpTaskId(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ProspectClientError("That ClickUp link doesn't look right -- paste the task's link or its ID.");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const t = parts.indexOf("t");
    const id = t >= 0 ? parts[parts.length - 1] : undefined;
    if (url.hostname !== "app.clickup.com" || !id || t === parts.length - 1 || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
      throw new ProspectClientError("That isn't a ClickUp task link (https://app.clickup.com/t/...) -- paste the task's link or its ID.");
    }
    return id;
  }
  const id = value.replace(/^#/, "");
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw new ProspectClientError("That doesn't look like a ClickUp task ID -- paste the task's link or its ID.");
  return id;
}

export async function findOrCreateProspectClient(input: { workspaceId: string; name: string; websiteUrl: string; clickupTask: string }) {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw new ProspectClientError("Enter the client's name.");
  const domain = bareDomain(input.websiteUrl.trim().slice(0, 300)) || null;
  const domainReportTaskId = toClickUpTaskId(input.clickupTask.slice(0, 300));
  // One row per name, also when two people press Run at the same moment.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain-client:${input.workspaceId}:${name.toLowerCase()}`}))`;
    const existing = await tx.client.findFirst({
      where: { workspaceId: input.workspaceId, kind: "domain", archivedAt: null, name: { equals: name, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
    });
    const select = { id: true, name: true, domain: true, domainReportTaskId: true } as const;
    if (existing) {
      return tx.client.update({ where: { id: existing.id }, data: { domain, domainReportTaskId, isActive: true }, select });
    }
    return tx.client.create({ data: { workspaceId: input.workspaceId, name, domain, domainReportTaskId, kind: "domain" }, select });
  });
}
