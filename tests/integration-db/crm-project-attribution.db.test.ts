/**
 * Corporate projects and which event a deal counts under (Nov 12, 2026), on a
 * REAL Postgres.
 *
 * A project linked to an event hands its deals to that event wherever deals
 * are counted per event: the board's event filter, the reports and the event's
 * Budget revenue. That is a relation filter (`project: { eventId }`) ORed with
 * the deal's own column, composed with the other filters: a mocked Prisma
 * returns whatever it is told, so only the database can show the rows are the
 * right ones. Also proven here: the unique name index under two simultaneous
 * creates, and that a project holding deals cannot be deleted out from under them.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { buildDealWhere } from "@/crm/lib/deal-filters";
import { crmRevenueProvider } from "@/crm/integrations/revenue-provider";
import { buildCrmReport } from "@/crm/services/report-service";
import { createProject, updateProject } from "@/crm/services/project-service";
import { createDeal, updateDeal } from "@/crm/services/deal-service";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;
let eventId: string;
let stageId: string;
let solo: string;
let linked: string;
let n = 0;

const caller = () => ({ organizationId: seed.orgId, userId: seed.userId, source: "rest" as const });

async function project(name: string, linkTo: string | null = null): Promise<string> {
  const res = await createProject({ ...caller(), name, eventId: linkTo });
  if (!res.ok) throw new Error(`createProject failed: ${res.code}`);
  return res.project.id;
}

async function deal(
  name: string,
  target: { eventId?: string; projectId?: string },
  over: { status?: "OPEN" | "WON" | "LOST"; dealValue?: number; archived?: boolean; wonAt?: Date } = {},
): Promise<string> {
  const row = await db.crmDeal.create({
    data: {
      organizationId: seed.orgId,
      name,
      stageId,
      currency: "USD",
      status: over.status ?? "WON",
      dealValue: over.dealValue ?? 100,
      wonAt: over.wonAt ?? null,
      archivedAt: over.archived ? new Date() : null,
      ...target,
    },
    select: { id: true },
  });
  return row.id;
}

const names = async (where: ReturnType<typeof buildDealWhere>) =>
  (await db.crmDeal.findMany({ where, select: { name: true } })).map((d) => d.name).sort();

/** Poll until a count reaches what the test expects (writes made after a service returned). */
async function settled(count: () => Promise<number>, atLeast: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while ((await count()) < atLeast && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const filter = (params: Parameters<typeof buildDealWhere>[0]) =>
  buildDealWhere(params, { organizationId: seed.orgId, canSeeValues: true });

beforeEach(async () => {
  seed = await resetCrm();
  n += 1;
  const [event, stage] = await Promise.all([
    db.event.create({
      data: { organizationId: seed.orgId, name: "BRIDGES 2027", slug: `bridges-${n}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
      select: { id: true },
    }),
    db.crmPipelineStage.create({ data: { organizationId: seed.orgId, name: "New", sortOrder: 0 }, select: { id: true } }),
  ]);
  eventId = event.id;
  stageId = stage.id;
  solo = await project("Novartis Ad Board");
  linked = await project("Bridges (entered twice)", eventId);

  await deal("event deal", { eventId }, { dealValue: 100 });
  await deal("linked project deal", { projectId: linked }, { dealValue: 300, wonAt: new Date("2027-01-20") });
  await deal("linked project, lost", { projectId: linked }, { status: "LOST" });
  await deal("linked project, archived", { projectId: linked }, { archived: true });
  await deal("solo project deal", { projectId: solo }, { dealValue: 700 });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("the deals that count under an event", () => {
  it("the event filter takes the event's own deals and the linked project's, never the unlinked project's", async () => {
    expect(await names(filter({ eventId }))).toEqual(["event deal", "linked project deal", "linked project, lost"]);
  });

  it("composes with 'closed in this window' and with the project filter, each narrowing", async () => {
    expect(await names(filter({ eventId, dateField: "closed", from: "2027-01-01", to: "2027-01-31" }))).toEqual(["linked project deal"]);
    expect(await names(filter({ projectId: linked }))).toEqual(["linked project deal", "linked project, lost"]);
    expect(await names(filter({ projectId: solo, eventId }))).toEqual([]);
  });

  it("the event's Budget revenue reads the linked project's won deals, and stops when the link is cleared", async () => {
    const won = async () =>
      (await crmRevenueProvider.wonDealsForEvent({ organizationId: seed.orgId, eventId })).map((d) => Number(d.dealValue)).sort((a, b) => a - b);
    expect(await won()).toEqual([100, 300]);

    const res = await updateProject({ ...caller(), projectId: linked, eventId: null });
    expect(res.ok).toBe(true);
    expect(await won()).toEqual([100]);
    // Nothing was moved: the deals are still on the project.
    expect(await names(filter({ projectId: linked }))).toEqual(["linked project deal", "linked project, lost"]);
  });

  it("the report puts every live deal under exactly one heading", async () => {
    const report = await buildCrmReport({ organizationId: seed.orgId, canSeeValues: true, filters: {}, groupBy: "attribution" });
    expect(report.breakdown!.rows.map((r) => [r.label, r.totalCount, r.wonValue])).toEqual([
      ["BRIDGES 2027", 3, 400],
      ["Novartis Ad Board (corporate project)", 1, 700],
    ]);
    const byProject = await buildCrmReport({ organizationId: seed.orgId, canSeeValues: true, filters: {}, groupBy: "project" });
    expect(byProject.breakdown!.rows.map((r) => [r.label, r.totalCount])).toEqual([
      ["Bridges (entered twice)", 2],
      ["Novartis Ad Board", 1],
      ["No corporate project (event deals)", 1],
    ]);
  });
});

describe("a deal is for an event or a project", () => {
  it("the service writes one and clears the other on a move", async () => {
    const created = await createDeal({ ...caller(), name: "Pfizer Experts Tour", stageId, projectId: solo });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.deal).toMatchObject({ projectId: solo, eventId: null });

    const moved = await updateDeal({ ...caller(), dealId: created.deal.id, eventId });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.deal).toMatchObject({ projectId: null, eventId });

    // The service writes its two History lines AFTER it returns. Let them land:
    // the next test's TRUNCATE would otherwise deadlock with them.
    await settled(() => db.crmActivity.count({ where: { entityId: created.deal.id } }), 2);
    // The move is on record, with both sides of it.
    const history = await db.crmActivity.findFirst({ where: { entityId: created.deal.id, action: "UPDATE" }, select: { changes: true } });
    expect(JSON.stringify(history?.changes)).toContain("projectId");
    expect(JSON.stringify(history?.changes)).toContain("eventId");
  });
});

describe("the project list keeps one name each", () => {
  it("two people creating the same name at once: one project, one NAME_TAKEN", async () => {
    const results = await Promise.all([
      createProject({ ...caller(), name: "Amgen Symposium" }),
      createProject({ ...caller(), name: "  amgen   SYMPOSIUM " }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "NAME_TAKEN" });
    expect(await db.crmProject.count({ where: { organizationId: seed.orgId, nameKey: "amgen symposium" } })).toBe(1);
  });

  it("a project that holds deals cannot be deleted out from under them", async () => {
    await expect(db.crmProject.delete({ where: { id: solo } })).rejects.toMatchObject({ code: "P2003" });
    expect(await db.crmProject.count({ where: { id: solo } })).toBe(1);
  });
});
