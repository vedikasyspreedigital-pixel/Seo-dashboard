import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";

// Local only: real Postgres (localhost:5433). Exercises only the new
// client_report_configs table -- no ranking_runs/ranking_rows/state-machine
// code is touched or imported here.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function cleanupClient(clientId: string) {
  await prisma.clientReportConfig.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("create: persists a report config with the expected defaults and JSON fields intact", async () => {
  const client = await makeClient(`Report Config Test - create ${randomUUID()}`);
  try {
    const config = await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary", "wins", "losses", "recommendations"],
        metricsEnabled: ["averageRank", "top3", "top10", "notIn100"],
        customInstructions: "Client cares about Rockingham and Mandurah suburb terms.",
        recipients: ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"],
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });

    assert.equal(config.clientId, client.id);
    assert.equal(config.reportTone, "professional");
    assert.deepEqual(config.sectionsEnabled, ["summary", "wins", "losses", "recommendations"]);
    assert.deepEqual(config.metricsEnabled, ["averageRank", "top3", "top10", "notIn100"]);
    assert.deepEqual(config.recipients, ["ops@cashforcarsperth.com.au", "owner@cashforcarsperth.com.au"]);
    assert.equal(config.reportingFrequency, "weekly");
    assert.equal(config.templateId, "standard-v1");
    assert.equal(config.isActive, true); // default
    assert.ok(config.createdAt);
    assert.ok(config.updatedAt);
  } finally {
    await cleanupClient(client.id);
  }
});

test("read: fetch by id and by clientId, including the client relation", async () => {
  const client = await makeClient(`Report Config Test - read ${randomUUID()}`);
  try {
    const created = await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "casual",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["hello@example.com"],
        reportingFrequency: "monthly",
        templateId: "minimal-v1",
      },
    });

    const byId = await prisma.clientReportConfig.findUniqueOrThrow({
      where: { id: created.id },
      include: { client: true },
    });
    assert.equal(byId.client.id, client.id);
    assert.equal(byId.client.name, client.name);

    const byClientId = await prisma.clientReportConfig.findMany({ where: { clientId: client.id } });
    assert.equal(byClientId.length, 1);
    assert.equal(byClientId[0].id, created.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("update: mutates fields in place and can flip isActive", async () => {
  const client = await makeClient(`Report Config Test - update ${randomUUID()}`);
  try {
    const created = await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["a@example.com"],
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });

    const updated = await prisma.clientReportConfig.update({
      where: { id: created.id },
      data: {
        reportTone: "technical",
        sectionsEnabled: ["summary", "full_table"],
        recipients: ["a@example.com", "b@example.com"],
        isActive: false,
      },
    });

    assert.equal(updated.reportTone, "technical");
    assert.deepEqual(updated.sectionsEnabled, ["summary", "full_table"]);
    assert.deepEqual(updated.recipients, ["a@example.com", "b@example.com"]);
    assert.equal(updated.isActive, false);
    // unchanged fields survive the partial update untouched
    assert.equal(updated.reportingFrequency, "weekly");
    assert.equal(updated.templateId, "standard-v1");
  } finally {
    await cleanupClient(client.id);
  }
});

test("a client can hold more than one config row (history), filterable by isActive", async () => {
  const client = await makeClient(`Report Config Test - multiple configs ${randomUUID()}`);
  try {
    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary"],
        metricsEnabled: ["averageRank"],
        recipients: ["old@example.com"],
        reportingFrequency: "monthly",
        templateId: "standard-v1",
        isActive: false,
      },
    });
    const active = await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "casual",
        sectionsEnabled: ["summary", "wins"],
        metricsEnabled: ["averageRank", "top10"],
        recipients: ["new@example.com"],
        reportingFrequency: "weekly",
        templateId: "standard-v2",
        isActive: true,
      },
    });

    const all = await prisma.clientReportConfig.findMany({ where: { clientId: client.id } });
    assert.equal(all.length, 2);

    const activeOnly = await prisma.clientReportConfig.findMany({ where: { clientId: client.id, isActive: true } });
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].id, active.id);
  } finally {
    await cleanupClient(client.id);
  }
});

test("foreign key: a client with an existing report config cannot be deleted until the config is removed", async () => {
  const client = await makeClient(`Report Config Test - FK restrict ${randomUUID()}`);
  const config = await prisma.clientReportConfig.create({
    data: {
      clientId: client.id,
      reportTone: "professional",
      sectionsEnabled: ["summary"],
      metricsEnabled: ["averageRank"],
      recipients: ["a@example.com"],
      reportingFrequency: "weekly",
      templateId: "standard-v1",
    },
  });

  await assert.rejects(() => prisma.client.delete({ where: { id: client.id } }), /Foreign key constraint/);

  // Removing the dependent row first allows the client delete to succeed.
  await prisma.clientReportConfig.delete({ where: { id: config.id } });
  await prisma.client.delete({ where: { id: client.id } });

  const stillThere = await prisma.client.findUnique({ where: { id: client.id } });
  assert.equal(stillThere, null);
});

test.after(async () => {
  await prisma.$disconnect();
});
