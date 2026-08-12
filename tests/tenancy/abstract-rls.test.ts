/**
 * Abstract domain sweep (Domain #11): the flat policies from prisma/rls/abstract.sql
 * — the SAME file the future platform bootstrap applies — enforced end-to-end
 * through the ALS store → SET LOCAL extension → pgbouncer, as the non-owner
 * app_user, across Abstract + AbstractTheme + ReviewCriterion + AbstractReviewer
 * + AbstractReviewSubmission.
 *
 * Domain-specific proofs beyond the standard set:
 *   - AbstractTheme is @@unique([eventId, name]) — BOTH orgs hold a theme on the
 *     SAME name, so an unscoped by-name lookup returns only the caller's row (the
 *     ticketing shared-code shape);
 *   - AbstractReviewer + AbstractReviewSubmission are 2-hop (via Abstract → Event)
 *     and reference an org-INDEPENDENT reviewer User — their backfilled column is
 *     proven lane-scoped independently, incl. when addressed by the parent
 *     abstractId (the shape the resource-org submissions route uses).
 *
 * No defence-#1-in-isolation assertion: the abstract mutations bind the org via a
 * prior org-scoped load / the service's org-scoped where (the CRM precedent), not
 * a write-side compound-where on these rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  SPEAKER_A_ID,
  SHARED_ABSTRACT_THEME_NAME,
  ABSTRACT_A_ID,
  ABSTRACT_B_ID,
  ABSTRACT_THEME_A_ID,
  ABSTRACT_THEME_B_ID,
  REVIEW_CRITERION_B_ID,
  ABSTRACT_REVIEWER_A_ID,
  ABSTRACT_REVIEWER_B_ID,
  ABSTRACT_SUBMISSION_A_ID,
  ABSTRACT_SUBMISSION_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Abstract RLS (prisma/rls/abstract.sql) via the SET LOCAL extension", () => {
  it("scoped Abstract findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.abstract.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([ABSTRACT_A_ID]);
  });

  it("the SHARED abstract-theme name resolves per-lane (unscoped by-name lookup)", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.abstractTheme.findMany({ where: { name: SHARED_ABSTRACT_THEME_NAME }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.abstractTheme.findMany({ where: { name: SHARED_ABSTRACT_THEME_NAME }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([ABSTRACT_THEME_A_ID]);
    expect(b.map((r) => r.id)).toEqual([ABSTRACT_THEME_B_ID]);
  });

  it("cross-tenant miss by id: B's Abstract is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.abstract.findUnique({ where: { id: ABSTRACT_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("ReviewCriterion is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.reviewCriterion.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.reviewCriterion.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.reviewCriterion.findUnique({ where: { id: REVIEW_CRITERION_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("AbstractReviewer (2-hop, org-independent reviewer User) is lane-scoped", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.abstractReviewer.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.abstractReviewer.findUnique({ where: { id: ABSTRACT_REVIEWER_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    const own = await runWithTenant(ORG_A_ID, () =>
      db.abstractReviewer.findUnique({ where: { id: ABSTRACT_REVIEWER_A_ID }, select: { id: true } }),
    );
    expect(own?.id).toBe(ABSTRACT_REVIEWER_A_ID);
  });

  it("AbstractReviewSubmission (2-hop) is lane-scoped even addressed by the parent abstractId", async () => {
    // The resource-org submissions route lists by abstractId — B's submission
    // under B's abstract must not surface under A's store.
    const aById = await runWithTenant(ORG_A_ID, () =>
      db.abstractReviewSubmission.findMany({ where: { abstractId: ABSTRACT_B_ID }, select: { id: true } }),
    );
    expect(aById).toHaveLength(0);
    const bOwn = await runWithTenant(ORG_B_ID, () =>
      db.abstractReviewSubmission.findMany({ where: { abstractId: ABSTRACT_B_ID }, select: { id: true } }),
    );
    expect(bOwn.map((r) => r.id)).toEqual([ABSTRACT_SUBMISSION_B_ID]);
    // A's own submission must still be visible in A's own lane. Without this
    // the suite only proves the lane hides things, never that it shows the
    // right ones, and a policy that returns nothing at all would pass.
    const aOwn = await runWithTenant(ORG_A_ID, () =>
      db.abstractReviewSubmission.findMany({ where: { abstractId: ABSTRACT_A_ID }, select: { id: true } }),
    );
    expect(aOwn.map((r) => r.id)).toEqual([ABSTRACT_SUBMISSION_A_ID]);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.abstractReviewSubmission.findUnique({ where: { id: ABSTRACT_SUBMISSION_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows on all 5 tables", async () => {
    expect(await db.abstract.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.abstractTheme.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.reviewCriterion.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.abstractReviewer.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.abstractReviewSubmission.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating an Abstract for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.abstract.create({
          data: {
            id: "tenancy-abs-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            speakerId: SPEAKER_A_ID,
            title: "Smuggled",
            content: "x",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN Abstract to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.abstract.update({
          where: { id: ABSTRACT_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's AbstractReviewSubmission cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.abstractReviewSubmission.delete({ where: { id: ABSTRACT_SUBMISSION_B_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
