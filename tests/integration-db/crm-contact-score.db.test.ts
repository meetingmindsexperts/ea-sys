/**
 * The stored contact score on a REAL Postgres (Oct 29, 2026).
 *
 * The score has two implementations: computeContactScore (TypeScript, what
 * every screen shows) and its SQL twin in contact-score-service.ts (what the
 * list sorts by). Only a real database can prove they agree, so this walks a
 * grid of open / won / archived deals through both. It also pins that the
 * deal-service writes refresh the score, and that the nightly repair fixes a
 * stale row and reports it.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { resetCrm, type CrmSeed } from "./helper";
import { computeContactScore } from "@/crm/lib/contact-score";
import { refreshContactScores, repairContactScores } from "@/crm/services/contact-score-service";
import { addDealContact, setDealArchived } from "@/crm/services/deal-service";

let seed: CrmSeed;
let stageId: string;

beforeEach(async () => {
  seed = await resetCrm();
  stageId = (
    await db.crmPipelineStage.create({ data: { organizationId: seed.orgId, name: "New", sortOrder: 0 }, select: { id: true } })
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
});

let n = 0;
async function contactWith(deals: Array<{ status: "OPEN" | "WON" | "LOST"; archived?: boolean }>) {
  n += 1;
  const contact = await db.crmContact.create({
    data: { organizationId: seed.orgId, firstName: "P", lastName: `L${n}`, email: `p${n}@x.com`, emailKey: `p${n}@x.com` },
    select: { id: true },
  });
  for (const d of deals) {
    const deal = await db.crmDeal.create({
      data: {
        organizationId: seed.orgId,
        name: `D${n}`,
        stageId,
        status: d.status,
        currency: "USD",
        archivedAt: d.archived ? new Date() : null,
      },
      select: { id: true },
    });
    await db.crmDealContact.create({ data: { organizationId: seed.orgId, dealId: deal.id, crmContactId: contact.id } });
  }
  return contact.id;
}

const stored = async (id: string) => (await db.crmContact.findUniqueOrThrow({ where: { id }, select: { score: true } })).score;

describe("stored contact score (real DB)", () => {
  it("the SQL formula agrees with computeContactScore across open, won and archived deals", async () => {
    const cases: Array<{ open: number; won: number; archivedOpen: number; lost: number }> = [];
    for (const open of [0, 1, 2, 3, 4]) for (const won of [0, 1, 2]) cases.push({ open, won, archivedOpen: open % 2, lost: 1 });

    const ids: string[] = [];
    for (const c of cases) {
      ids.push(
        await contactWith([
          ...Array.from({ length: c.open }, () => ({ status: "OPEN" as const })),
          ...Array.from({ length: c.won }, () => ({ status: "WON" as const })),
          ...Array.from({ length: c.archivedOpen }, () => ({ status: "OPEN" as const, archived: true })),
          ...Array.from({ length: c.lost }, () => ({ status: "LOST" as const })),
        ]),
      );
    }
    await refreshContactScores(seed.orgId, ids);

    for (const [i, c] of cases.entries()) {
      expect(await stored(ids[i]!), JSON.stringify(c)).toBe(computeContactScore({ openDeals: c.open, wonDeals: c.won }).total);
    }
  });

  it("a refresh never bumps updatedAt (the import reads it as a local edit)", async () => {
    const id = await contactWith([{ status: "WON" }]);
    const before = await db.crmContact.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    await refreshContactScores(seed.orgId, [id]);
    const after = await db.crmContact.findUniqueOrThrow({ where: { id }, select: { updatedAt: true, score: true } });
    expect(after.score).toBe(40);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("deal writes keep it current: adding a person, then archiving the deal", async () => {
    const id = await contactWith([]);
    const deal = await db.crmDeal.create({
      data: { organizationId: seed.orgId, name: "Gold", stageId, status: "OPEN", currency: "USD" },
      select: { id: true },
    });

    await addDealContact({ dealId: deal.id, crmContactId: id, organizationId: seed.orgId, userId: seed.userId, source: "rest" });
    expect(await stored(id)).toBe(30);

    await setDealArchived({ dealId: deal.id, organizationId: seed.orgId, userId: seed.userId, source: "rest", archived: true });
    expect(await stored(id)).toBe(0);
  });

  it("the nightly repair fixes a stale row and reports how many it fixed", async () => {
    const id = await contactWith([{ status: "OPEN" }, { status: "WON" }]);
    await db.$executeRaw`UPDATE "CrmContact" SET "score" = 0 WHERE id = ${id}`;

    expect(await repairContactScores(seed.orgId)).toBe(1);
    expect(await stored(id)).toBe(70);
    expect(await repairContactScores(seed.orgId)).toBe(0);
  });
});
