/**
 * Comms-log domain sweep (Domain #18): the policies from
 * prisma/rls/emaillog.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, on EmailLog + ScheduledEmail.
 *
 * Domain-specific proofs:
 *   - EmailLog has NO per-org unique field; both orgs' fixture rows carry the
 *     SAME `to` address (the MediaFile shape), so the by-recipient read
 *     resolving to one lane's row is what proves scoping.
 *   - The ASYMMETRIC EmailLog policy (owner decision Aug 3, 2026 —
 *     "keep them, hidden"): a NULL-org row (auth email to an org-less
 *     account) INSERTS from a bare, store-less context (WITH CHECK first
 *     disjunct) but is READABLE from no lane and no bare context (USING
 *     stays strict) — both halves asserted, in that order, so the
 *     fail-closed assertions below run WITH the null row present.
 *   - A stamped insert smuggling ANOTHER org's id is still rejected (the
 *     strict WITH CHECK disjunct is not bypassed by the null carve-out).
 *   - ScheduledEmail: the WORKER CLAIM shape — a cross-tenant
 *     `updateMany({ id, status: PENDING } → PROCESSING)` matches zero rows,
 *     so a mis-laned worker can never claim another tenant's send.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EMAIL_LOG_A_ID,
  EMAIL_LOG_B_ID,
  EMAIL_LOG_NULLORG_ID,
  SHARED_EMAIL_TO,
  SCHED_EMAIL_A_ID,
  SCHED_EMAIL_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Comms-log RLS (prisma/rls/emaillog.sql) via the SET LOCAL extension", () => {
  it("EmailLog is lane-scoped: the SHARED recipient address resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.emailLog.findMany({ where: { to: SHARED_EMAIL_TO }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([EMAIL_LOG_A_ID]);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.emailLog.findMany({ where: { to: SHARED_EMAIL_TO }, select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([EMAIL_LOG_B_ID]);
  });

  it("cross-tenant EmailLog by-id read misses", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.emailLog.findUnique({ where: { id: EMAIL_LOG_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("ASYMMETRY write-half: a NULL-org row inserts from a bare store-less context (the auth-email path)", async () => {
    // logEmail's genuinely org-less sends (password reset / verification to an
    // org-null account) run with no tenant store; the WITH CHECK null carve-out
    // must admit them so the audit row is never silently discarded. createMany
    // (plain INSERT) matches the production path exactly — Prisma's create()
    // emits INSERT..RETURNING, whose returned row must ALSO pass the strict
    // USING check, so it is (correctly) rejected for a row no lane can read.
    const created = await db.emailLog.createMany({
      data: [
        {
          id: EMAIL_LOG_NULLORG_ID,
          organizationId: null,
          entityType: "USER",
          to: "orgless-registrant@example.com",
          subject: "Password reset (tenancy asymmetry fixture)",
          provider: "ses",
          status: "SENT",
        },
      ],
    });
    expect(created.count).toBe(1);
    // The RETURNING subtlety pinned: create() on the same shape is refused.
    await expect(
      db.emailLog.create({
        data: {
          id: "tenancy-elog-nullorg-returning",
          organizationId: null,
          entityType: "USER",
          to: "orgless-registrant@example.com",
          subject: "Password reset (RETURNING probe)",
          provider: "ses",
          status: "SENT",
        },
      }),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("ASYMMETRY read-half: the NULL-org row is invisible to BOTH tenant lanes (USING stays strict)", async () => {
    for (const org of [ORG_A_ID, ORG_B_ID]) {
      const seen = await runWithTenant(org, () =>
        db.emailLog.findUnique({ where: { id: EMAIL_LOG_NULLORG_ID }, select: { id: true } }),
      );
      expect(seen).toBeNull();
    }
  });

  it("WITH CHECK still rejects a stamped insert smuggled into ANOTHER org's lane (null carve-out is no bypass)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.emailLog.create({
          data: {
            id: "tenancy-elog-smuggled",
            organizationId: ORG_B_ID,
            to: "smuggle@example.com",
            subject: "smuggled",
            provider: "ses",
            status: "SENT",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK strict disjunct proven via createMany (no RETURNING — only WITH CHECK can reject it)", async () => {
    // Review Aug 3: the create() smuggle above is ALSO rejected by USING on
    // its RETURNING clause, so on this — the one ASYMMETRIC policy in the
    // sweep — it cannot distinguish a real WITH CHECK from a permissive
    // `WITH CHECK (true)`. Verified empirically: with WITH CHECK loosened to
    // (true), every other assertion in this file still passes and ONLY this
    // one fails. createMany emits a plain INSERT, so this rejection can come
    // from nothing but the strict disjunct of WITH CHECK.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.emailLog.createMany({
          data: [
            {
              id: "tenancy-elog-smuggled-many",
              organizationId: ORG_B_ID,
              to: "smuggle-many@example.com",
              subject: "smuggled",
              provider: "ses",
              status: "SENT",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE on EmailLog is blocked (A cannot move its OWN row to B); nulling is by-design permitted but untested-in-place", async () => {
    // USING admits A's own row; WITH CHECK rejects the new org-B version.
    // NOTE: `SET organizationId = NULL` from the owning lane IS permitted by
    // the asymmetric policy (a tenant hiding its own audit row) — accepted:
    // any principal that can update its row can already DELETE it (USING
    // alone gates deletes). Not asserted here because it would mutate the
    // fixture and make the file more order-dependent.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.emailLog.update({
          where: { id: EMAIL_LOG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("fail-closed: no tenant store → zero readable rows on both tables (incl. the existing null-org row)", async () => {
    // Runs AFTER the null-org insert above, so this also proves the bare
    // read does NOT surface null-org rows (write-only from app contexts).
    expect(await db.emailLog.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.scheduledEmail.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("ScheduledEmail is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.scheduledEmail.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.scheduledEmail.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.scheduledEmail.findUnique({ where: { id: SCHED_EMAIL_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the worker CLAIM shape cannot cross tenants: PENDING→PROCESSING updateMany on B's row under A matches 0", async () => {
    const claim = await runWithTenant(ORG_A_ID, () =>
      db.scheduledEmail.updateMany({
        where: { id: SCHED_EMAIL_B_ID, status: "PENDING" },
        data: { status: "PROCESSING", claimToken: "tenancy-bogus-claim" },
      }),
    );
    expect(claim.count).toBe(0);
    // B's row is untouched — still claimable on its own lane.
    const own = await runWithTenant(ORG_B_ID, () =>
      db.scheduledEmail.findUnique({
        where: { id: SCHED_EMAIL_B_ID },
        select: { status: true, claimToken: true },
      }),
    );
    expect(own?.status).toBe("PENDING");
    expect(own?.claimToken).toBeNull();
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN scheduled email to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.scheduledEmail.update({
          where: { id: SCHED_EMAIL_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's scheduled email cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.scheduledEmail.delete({ where: { id: SCHED_EMAIL_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
