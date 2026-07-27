/**
 * CrmContact policy pass (Phase 2, domain pass #5 — policy-only, like
 * MediaFile's first pass): the flat per-domain RLS policy from
 * prisma/rls/crmcontact.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user.
 *
 * CrmContact holds the org's business-contact book (sponsor reps' emails,
 * mobiles, notes) — the CRM's PII table, which is why it gets its policy
 * before the rest of the Crm* family (those land with the full CRM-domain
 * sweep). `emailKey` is unique only per org, so both orgs hold a contact on
 * the SAME emailKey — an unscoped `where:{ emailKey }` returning only the
 * caller's row is what proves scoping.
 *
 * NO defence-#1-in-isolation assertion yet: the CRM services org-bind via
 * lookups but their by-id mutations are not compound-where'd (that's the C1
 * step of the future full sweep) — same staging MediaFile went through.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  SHARED_CRM_EMAIL_KEY,
  CRM_CT_A_SHARED_ID,
  CRM_CT_B_SHARED_ID,
  ORG_B_ONLY_CRM_EMAIL_KEY,
  CRM_CT_B_ONLY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("CrmContact RLS (prisma/rls/crmcontact.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own CRM contacts", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.crmContact.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
  });

  it("a DELIBERATELY-unscoped emailKey query cannot read another tenant's contact (defence #2)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.crmContact.findFirst({
        where: { emailKey: ORG_B_ONLY_CRM_EMAIL_KEY },
        select: { id: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("cross-tenant miss by id: B's contact is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.crmContact.findUnique({ where: { id: CRM_CT_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.crmContact.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("shared emailKey (unique per org): each lane sees exactly ITS row", async () => {
    for (const [orgId, expectedId] of [
      [ORG_A_ID, CRM_CT_A_SHARED_ID],
      [ORG_B_ID, CRM_CT_B_SHARED_ID],
    ] as const) {
      const rows = await runWithTenant(orgId, () =>
        db.crmContact.findMany({
          where: { emailKey: SHARED_CRM_EMAIL_KEY },
          select: { id: true, organizationId: true },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(expectedId);
      expect(rows[0].organizationId).toBe(orgId);
    }
  });

  it("WITH CHECK rejects creating a CRM contact for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.crmContact.create({
          data: {
            id: "tenancy-crmct-smuggled",
            organizationId: ORG_B_ID, // tenant A writing into B
            firstName: "Smuggled",
            lastName: "Rep",
            email: "smuggled.rep@tenancy.test",
            emailKey: "smuggled.rep@tenancy.test",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN contact to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.crmContact.update({
          where: { id: CRM_CT_A_SHARED_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's contact cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.crmContact.delete({ where: { id: CRM_CT_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
