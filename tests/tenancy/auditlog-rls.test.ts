/**
 * AuditLog domain sweep (Domain #19): the policy from prisma/rls/auditlog.sql
 * — the SAME file the future platform bootstrap applies — enforced end-to-end
 * through the ALS store → withAuditOrgStamp → SET LOCAL extension → pgbouncer,
 * as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - AuditLog has NO per-org unique field; both orgs' fixture rows carry the
 *     SAME entityType/entityId pair (the per-entity timeline shape), so the
 *     unscoped entity-bound read resolving to one lane's row is what proves
 *     scoping — this is exactly the query activity-feed.ts issues.
 *   - THE AUTO-STAMP, live: this file runs against the app's real extended
 *     client, so an org-less `create()` inside a tenant lane must come back
 *     stamped with that lane's org (withAuditOrgStamp resolving via the
 *     ambient store) AND pass the policy — extension + policy + pooler in
 *     one assertion.
 *   - The ASYMMETRIC policy (EmailLog's shape): a NULL-org row inserts via
 *     bare createMany (WITH CHECK carve-out) but is readable from no lane
 *     (USING strict); create() on the same shape is rejected because its
 *     RETURNING must pass USING — the Domain-#18 discovery, re-pinned here
 *     because ALL 163 production AuditLog writers use create(), making this
 *     rejection the documented platform-lane behavior for org-null audits.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  AUDIT_LOG_A_ID,
  AUDIT_LOG_B_ID,
  AUDIT_LOG_NULLORG_ID,
  SHARED_AUDIT_ENTITY_TYPE,
  SHARED_AUDIT_ENTITY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("AuditLog RLS (prisma/rls/auditlog.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED entityType/entityId pair resolves to each lane's own row (the activity-feed shape)", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.auditLog.findMany({
        where: { entityType: SHARED_AUDIT_ENTITY_TYPE, entityId: SHARED_AUDIT_ENTITY_ID },
        select: { id: true },
      }),
    );
    expect(inA.map((r) => r.id)).toEqual([AUDIT_LOG_A_ID]);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.auditLog.findMany({
        where: { entityType: SHARED_AUDIT_ENTITY_TYPE, entityId: SHARED_AUDIT_ENTITY_ID },
        select: { id: true },
      }),
    );
    expect(inB.map((r) => r.id)).toEqual([AUDIT_LOG_B_ID]);
  });

  it("cross-tenant by-id read misses", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.auditLog.findUnique({ where: { id: AUDIT_LOG_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("AUTO-STAMP live: an org-less create() inside A's lane comes back stamped A, readable only in A", async () => {
    // No organizationId, no eventId in the data — withAuditOrgStamp must
    // resolve the ambient lane org, and the stamped row must then satisfy
    // BOTH policy halves (WITH CHECK on insert, USING on the RETURNING).
    const created = await runWithTenant(ORG_A_ID, () =>
      db.auditLog.create({
        data: {
          id: "tenancy-audit-ambient-stamped",
          action: "TENANCY_TEST",
          entityType: SHARED_AUDIT_ENTITY_TYPE,
          entityId: "tenancy-ambient-probe",
        },
      }),
    );
    expect(created.organizationId).toBe(ORG_A_ID);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.auditLog.findUnique({ where: { id: created.id }, select: { id: true } }),
    );
    expect(inB).toBeNull();
    // Clean in-lane so re-runs inside one harness session stay green.
    await runWithTenant(ORG_A_ID, () => db.auditLog.delete({ where: { id: created.id } }));
  });

  it("ASYMMETRY write-half: a NULL-org row inserts via bare createMany; create() is rejected on its RETURNING", async () => {
    const created = await db.auditLog.createMany({
      data: [
        {
          id: AUDIT_LOG_NULLORG_ID,
          organizationId: null,
          action: "PASSWORD_RESET",
          entityType: "User",
          entityId: "tenancy-orgless-user",
        },
      ],
    });
    expect(created.count).toBe(1);
    // The production-relevant pin: every real AuditLog writer uses create(),
    // whose INSERT..RETURNING must pass the strict USING — so from an
    // app-role lane a NULL-org audit write is refused (fire-and-forget catch
    // → logged lost row on the platform; the documented precondition).
    await expect(
      db.auditLog.create({
        data: {
          id: "tenancy-audit-nullorg-returning",
          organizationId: null,
          action: "PASSWORD_RESET",
          entityType: "User",
          entityId: "tenancy-orgless-user",
        },
      }),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("ASYMMETRY read-half: the NULL-org row is invisible to BOTH tenant lanes", async () => {
    for (const org of [ORG_A_ID, ORG_B_ID]) {
      const seen = await runWithTenant(org, () =>
        db.auditLog.findUnique({ where: { id: AUDIT_LOG_NULLORG_ID }, select: { id: true } }),
      );
      expect(seen).toBeNull();
    }
  });

  it("smuggle via create(): an explicit foreign org in A's lane is rejected (explicit beats ambient, then the policy refuses)", async () => {
    // Also pins withAuditOrgStamp's precedence: the explicit ORG_B_ID must
    // survive the stamp (NOT be overwritten by the ambient ORG_A_ID) — if the
    // stamp clobbered it, this insert would succeed and the assertion fail.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.auditLog.create({
          data: {
            id: "tenancy-audit-smuggled",
            organizationId: ORG_B_ID,
            action: "TENANCY_TEST",
            entityType: SHARED_AUDIT_ENTITY_TYPE,
            entityId: "tenancy-smuggle-probe",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK strict disjunct proven via createMany (no RETURNING — only WITH CHECK can reject it)", async () => {
    // The asymmetric-policy proof shape from Domain #18: a create()-based
    // smuggle is ALSO rejected by USING on its RETURNING, so it cannot
    // distinguish a real WITH CHECK from `WITH CHECK (true)`. createMany
    // emits a plain INSERT — this rejection can come from nothing but the
    // strict disjunct.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.auditLog.createMany({
          data: [
            {
              id: "tenancy-audit-smuggled-many",
              organizationId: ORG_B_ID,
              action: "TENANCY_TEST",
              entityType: SHARED_AUDIT_ENTITY_TYPE,
              entityId: "tenancy-smuggle-probe",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN row to B (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.auditLog.update({
          where: { id: AUDIT_LOG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("fail-closed: no tenant store → zero readable rows (incl. the existing null-org row)", async () => {
    // Runs AFTER the null-org insert above, so this also proves bare reads
    // never surface null-org rows (write-only from app contexts).
    expect(
      await db.auditLog.findMany({
        where: { entityType: { in: [SHARED_AUDIT_ENTITY_TYPE, "User"] } },
        select: { id: true },
      }),
    ).toHaveLength(0);
  });

  it("cross-tenant DELETE misses: B's row cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.auditLog.delete({ where: { id: AUDIT_LOG_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
