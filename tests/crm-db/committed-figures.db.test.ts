/**
 * A budget line's committed figures on a REAL Postgres (review of 15 September
 * 2026). The old path read the line's figure and wrote back that figure plus
 * the order, so two orders on one line at the same moment could lose one; and
 * a new version kept the figures it copied when it was drafted. A mocked
 * Prisma has one fake connection, so neither can be shown there.
 *
 * Run: docker compose --profile crm-test up -d
 *      CRM_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:crm-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { lockEventCommitted, syncBudgetCommitted, syncLineCommitted } from "@/procurement/services/committed-figures";
import { resetCrm } from "./helper";

interface Seed { orgId: string; userId: string; eventId: string; categoryId: string; supplierId: string; v1: string }
let s: Seed;
let n = 0;

async function seed(): Promise<Seed> {
  const { orgId, userId } = await resetCrm();
  const event = await db.event.create({ data: { organizationId: orgId, name: "Committed Test", slug: `committed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, startDate: new Date("2026-10-01"), endDate: new Date("2026-10-02") }, select: { id: true } });
  const category = await db.budgetCategory.create({ data: { organizationId: orgId, code: "AV", name: "Audio visual" }, select: { id: true } });
  const supplier = await db.supplier.create({ data: { organizationId: orgId, code: "GAV", legalName: "Gulf AV LLC", displayName: "Gulf AV", currency: "AED" }, select: { id: true } });
  const v1 = await version(orgId, userId, event.id, 1, "ACTIVE");
  await line(orgId, v1, category.id);
  return { orgId, userId, eventId: event.id, categoryId: category.id, supplierId: supplier.id, v1 };
}

async function version(orgId: string, userId: string, eventId: string, versionNo: number, status: "ACTIVE" | "DRAFT" | "UNDER_REVIEW") {
  const b = await db.eventBudget.create({ data: { organizationId: orgId, eventId, eventCode: "CF26", versionNo, reportingCurrency: "AED", ownerUserId: userId, createdByUserId: userId, status }, select: { id: true } });
  return b.id;
}

async function line(orgId: string, budgetId: string, categoryId: string, committed = "0") {
  await db.budgetLine.create({ data: { organizationId: orgId, budgetId, lineKey: "k-av", categoryId, description: "LED wall", transactionCurrency: "AED", committedOpen: committed, committedTotal: committed } });
}

async function issue(budgetId: string, amount: string) {
  n += 1;
  return db.$transaction(async (tx) => {
    await tx.commitment.create({ data: { organizationId: s.orgId, commitmentNo: `PO-T-${n}-${Math.random().toString(36).slice(2, 6)}`, budgetId, lineKey: "k-av", supplierId: s.supplierId, eventCode: "CF26", currency: "AED", amount, fxRateToReporting: "1", status: "APPROVED" } });
    return syncLineCommitted(tx as never, { organizationId: s.orgId, budgetId, lineKey: "k-av" });
  }, { timeout: 20_000, maxWait: 20_000 });
}

async function activate(v2: string) {
  await db.$transaction(async (tx) => {
    await lockEventCommitted(tx as never, s.orgId, v2);
    await tx.eventBudget.updateMany({ where: { eventId: s.eventId, status: { in: ["ACTIVE", "FROZEN"] }, id: { not: v2 } }, data: { status: "ARCHIVED" } });
    await tx.eventBudget.update({ where: { id: v2 }, data: { status: "ACTIVE" } });
    await syncBudgetCommitted(tx as never, s.orgId, v2);
  }, { timeout: 20_000, maxWait: 20_000 });
}

const committedOn = async (budgetId: string) => {
  const l = await db.budgetLine.findFirstOrThrow({ where: { budgetId, lineKey: "k-av" }, select: { committedOpen: true, committedTotal: true } });
  return [l.committedOpen.toFixed(4), l.committedTotal.toFixed(4)];
};

beforeEach(async () => {
  s = await seed();
});

describe("committed figures on a real database", () => {
  it("ten orders issued on one line at once all count", async () => {
    await Promise.all(Array.from({ length: 10 }, () => issue(s.v1, "1000.0000")));
    expect(await committedOn(s.v1)).toEqual(["10000.0000", "10000.0000"]);
  });

  it("an order issued on the old version after the new one was drafted is counted when the new one takes over, and a later cancel releases on the new one", async () => {
    await issue(s.v1, "2000.0000");
    const v2 = await version(s.orgId, s.userId, s.eventId, 2, "UNDER_REVIEW");
    await line(s.orgId, v2, s.categoryId, "2000"); // what the draft copied
    await issue(s.v1, "500.0000"); // v1 is still the active version
    expect(await committedOn(s.v1)).toEqual(["2500.0000", "2500.0000"]);

    await activate(v2);
    expect(await committedOn(v2)).toEqual(["2500.0000", "2500.0000"]);

    const first = await db.commitment.findFirstOrThrow({ where: { organizationId: s.orgId, amount: "2000" }, select: { id: true } });
    const target = await db.$transaction(async (tx) => {
      await tx.commitment.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
      return syncLineCommitted(tx as never, { organizationId: s.orgId, budgetId: s.v1, lineKey: "k-av" });
    });
    expect(target).toBe(v2);
    expect(await committedOn(v2)).toEqual(["500.0000", "500.0000"]);
    expect(await committedOn(s.v1)).toEqual(["2500.0000", "2500.0000"]); // the archived version is history
  });

  it("an activation racing orders on the old version neither deadlocks nor loses an order", async () => {
    const v2 = await version(s.orgId, s.userId, s.eventId, 2, "UNDER_REVIEW");
    await line(s.orgId, v2, s.categoryId);
    await Promise.all([issue(s.v1, "700.0000"), activate(v2), issue(s.v1, "300.0000")]);
    expect(await committedOn(v2)).toEqual(["1000.0000", "1000.0000"]);
  });
});
