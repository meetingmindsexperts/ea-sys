/**
 * Registration-core sweep (Phase 2, domain pass #8): the flat policies from
 * prisma/rls/registration.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, across the 5 core tables
 * (Registration, Attendee, Payment, RefundAttempt, RegistrationSerialCounter).
 *
 * Domain-specific proofs beyond the standard set:
 *   - the unscoped ATTENDEE by-email lookup (the exact shape of the public
 *     register's orphan-reuse findFirst) is lane-scoped — both orgs seed an
 *     attendee on ONE shared email (Attendee.email is not unique);
 *   - the SERIAL COUNTER's cross-tenant upsert is REJECTED, not silently
 *     misrouted — the flat column is what keeps the ON-CONFLICT path from
 *     raising a unique violation misread as "already registered";
 *   - defence #1 in isolation (owner bypasses the non-FORCE policy): the C1
 *     compound-where/eventId-bound updateMany shape (check-in claims,
 *     optimistic-lock write) matches ZERO rows for a wrong-event binding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
  ATTENDEE_A_ID,
  ATTENDEE_B_ID,
  REG_A_ID,
  REG_B_ID,
  SHARED_ATTENDEE_EMAIL,
  PAYMENT_A_ID,
  PAYMENT_B_ID,
  PAYMENT_B_STRIPE_PI,
  REFUND_ATTEMPT_A_ID,
  REFUND_ATTEMPT_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Registration-core RLS (prisma/rls/registration.sql) via the SET LOCAL extension", () => {
  it("scoped Registration findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.registration.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([REG_A_ID]);
  });

  it("cross-tenant miss by id: B's registration is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.registration.findUnique({ where: { id: REG_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the SHARED attendee email resolves per-lane (the orphan-reuse lookup shape)", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.attendee.findMany({ where: { email: SHARED_ATTENDEE_EMAIL }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.attendee.findMany({ where: { email: SHARED_ATTENDEE_EMAIL }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([ATTENDEE_A_ID]);
    expect(b.map((r) => r.id)).toEqual([ATTENDEE_B_ID]);
  });

  it("Payment: per-lane counts + B's globally-unique stripePaymentId invisible under A", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.payment.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.payment.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.payment.findUnique({ where: { stripePaymentId: PAYMENT_B_STRIPE_PI }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("RefundAttempt: per-lane counts + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.refundAttempt.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.refundAttempt.findUnique({ where: { id: REFUND_ATTEMPT_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    const own = await runWithTenant(ORG_A_ID, () =>
      db.refundAttempt.findUnique({ where: { id: REFUND_ATTEMPT_A_ID }, select: { id: true } }),
    );
    expect(own?.id).toBe(REFUND_ATTEMPT_A_ID);
  });

  it("fail-closed: flag on but NO tenant store → zero rows on every core table", async () => {
    expect(await db.registration.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.attendee.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.payment.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.refundAttempt.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.registrationSerialCounter.findMany({ select: { eventId: true } })).toHaveLength(0);
  });

  it("serial counter: own-org increment works; a cross-tenant upsert is REJECTED, not misrouted", async () => {
    // Own org — the getNextSerialId shape increments the visible row.
    const own = await runWithTenant(ORG_A_ID, () =>
      db.registrationSerialCounter.upsert({
        where: { eventId: EVENT_A_SHARED_ID },
        create: { eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, lastSerial: 1 },
        update: { lastSerial: { increment: 1 }, organizationId: ORG_A_ID },
        select: { lastSerial: true },
      }),
    );
    expect(own.lastSerial).toBeGreaterThan(1);

    // Cross-tenant: B's counter row is invisible under A → the upsert takes the
    // INSERT path into an existing PK / or the conflicting row fails the policy.
    // Either way it must REJECT — never silently update B's counter.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registrationSerialCounter.upsert({
          where: { eventId: EVENT_B_SHARED_ID },
          create: { eventId: EVENT_B_SHARED_ID, organizationId: ORG_A_ID, lastSerial: 99 },
          update: { lastSerial: { increment: 1 } },
        }),
      ),
    ).rejects.toBeTruthy();

    // ...and B's counter is untouched (owner view).
    const owner = ownerClient();
    try {
      const row = await owner.registrationSerialCounter.findUnique({
        where: { eventId: EVENT_B_SHARED_ID },
        select: { lastSerial: true, organizationId: true },
      });
      expect(row?.lastSerial).toBe(1);
      expect(row?.organizationId).toBe(ORG_B_ID);
    } finally {
      await owner.$disconnect();
    }
  });

  it("WITH CHECK rejects creating a registration for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registration.create({
          data: {
            id: "tenancy-reg-smuggled",
            eventId: EVENT_B_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            attendeeId: ATTENDEE_B_ID,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN registration to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registration.update({
          where: { id: REG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's payment cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.payment.delete({ where: { id: PAYMENT_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: the eventId-bound updateMany shape matches zero rows even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy — this exercises ONLY the C1
    // layer: the check-in-claim / optimistic-lock shape { id, eventId }.
    const owner = ownerClient();
    try {
      const res = await owner.registration.updateMany({
        where: { id: REG_B_ID, eventId: EVENT_A_SHARED_ID },
        data: { notes: "hijacked" },
      });
      expect(res.count).toBe(0);
      const row = await owner.registration.findUnique({
        where: { id: REG_B_ID },
        select: { notes: true },
      });
      expect(row?.notes).toBeNull();
    } finally {
      await owner.$disconnect();
    }
  });
});

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set — defence-#1 tests require the OWNER connection");
  return new PrismaClient({ datasourceUrl: url });
}
