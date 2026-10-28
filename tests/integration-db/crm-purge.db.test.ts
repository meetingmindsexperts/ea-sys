/**
 * CRM purge on a REAL Postgres (Oct 28, 2026, test list P0). The unit suite
 * mocks the transaction, so only Postgres can prove these:
 *
 *  - a failed audit write rolls the delete back: the deal, its History and its
 *    cascaded links are all still there (no unlogged permanent deletion);
 *  - a successful purge leaves exactly one CRM_PURGE audit row;
 *  - an active (restored) deal is never deleted by the guarded delete.
 *
 * The audit failure is real, not mocked: AuditLog.userId is a foreign key, so
 * a purge attributed to a user that does not exist fails at the insert.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { resetCrm, seedDeal, type CrmSeed } from "./helper";
import { purgeDeal } from "@/crm/services/crm-purge-service";

let seed: CrmSeed;
let dealId: string;
let contactId: string;

beforeEach(async () => {
  seed = await resetCrm();
  ({ dealId, contactId } = await seedDeal(seed));
  await db.crmDealContact.create({ data: { organizationId: seed.orgId, dealId, crmContactId: contactId, role: "PRIMARY" } });
  await db.crmActivity.create({
    data: { organizationId: seed.orgId, entityType: "DEAL", entityId: dealId, action: "CREATE", actorId: seed.userId },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

const archive = () => db.crmDeal.update({ where: { id: dealId }, data: { archivedAt: new Date() } });

describe("purgeDeal (real DB)", () => {
  it("a failed audit write rolls the whole purge back", async () => {
    await archive();
    const res = await purgeDeal({ organizationId: seed.orgId, userId: "no-such-user", dealId });

    expect(res).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(await db.crmDeal.count({ where: { id: dealId } })).toBe(1);
    expect(await db.crmDealContact.count({ where: { dealId } })).toBe(1);
    expect(await db.crmActivity.count({ where: { entityType: "DEAL", entityId: dealId } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "CRM_PURGE" } })).toBe(0);
  });

  it("a purge deletes the deal and its links and leaves one CRM_PURGE audit row", async () => {
    await archive();
    const res = await purgeDeal({ organizationId: seed.orgId, userId: seed.userId, dealId });

    expect(res).toEqual({ ok: true });
    expect(await db.crmDeal.count({ where: { id: dealId } })).toBe(0);
    expect(await db.crmDealContact.count({ where: { dealId } })).toBe(0);
    expect(await db.crmActivity.count({ where: { entityType: "DEAL", entityId: dealId } })).toBe(0);
    const audit = await db.auditLog.findMany({ where: { action: "CRM_PURGE", entityId: dealId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "CrmDeal", organizationId: seed.orgId, userId: seed.userId });
  });

  it("an active deal is refused and untouched", async () => {
    const res = await purgeDeal({ organizationId: seed.orgId, userId: seed.userId, dealId });

    expect(res).toMatchObject({ ok: false, code: "NOT_ARCHIVED" });
    expect(await db.crmDeal.count({ where: { id: dealId } })).toBe(1);
  });
});
