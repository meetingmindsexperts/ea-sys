/**
 * Dinner RSVP domain sweep (Domain #15): the flat policies from
 * prisma/rls/rsvp.sql — the SAME file the future platform bootstrap applies —
 * enforced end-to-end through the ALS store → SET LOCAL extension → pgbouncer,
 * as the non-owner app_user, across RsvpDinner + RsvpInvite (1-hop from Event)
 * + RsvpDinnerResponse (2-hop via RsvpInvite).
 *
 * Domain-specific proofs:
 *   - RsvpInvite has NO per-org unique on the email alone (only @@unique(
 *     [eventId, inviteeEmail])), so BOTH orgs invite the SAME address → an
 *     unscoped `where:{ inviteeEmail }` returns only the caller's row (the
 *     shared-value shape).
 *   - The token is GLOBALLY unique. A cross-tenant `findUnique({ token: B })`
 *     under A's store returns NULL — the exact public-route bootstrap: the
 *     rsvp/[token] route resolves the tenant org from the Event by host+slug
 *     first, then reads the token on that lane, so a token minted for B is
 *     invisible on A's lane.
 *   - RsvpDinnerResponse is the 2-hop child; reading it by inviteId still
 *     resolves only on the owning tenant's lane.
 *
 * No defence-#1-in-isolation assertion: every RSVP mutation binds the org via a
 * prior event load (staff) / publicEventWhere (public) + the runWithTenant wrap
 * (the Session Proposals / Abstract precedent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  SHARED_RSVP_INVITEE_EMAIL,
  RSVP_DINNER_A_ID,
  RSVP_DINNER_B_ID,
  RSVP_INVITE_A_ID,
  RSVP_INVITE_B_ID,
  RSVP_INVITE_B_TOKEN,
  RSVP_RESPONSE_A_ID,
  RSVP_RESPONSE_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Dinner RSVP RLS (prisma/rls/rsvp.sql) via the SET LOCAL extension", () => {
  it("shared invitee email is lane-scoped: unscoped by-email returns only the caller's row", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.rsvpInvite.findMany({
        where: { inviteeEmail: SHARED_RSVP_INVITEE_EMAIL },
        select: { id: true, organizationId: true },
      }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.rsvpInvite.findMany({
        where: { inviteeEmail: SHARED_RSVP_INVITEE_EMAIL },
        select: { id: true },
      }),
    );
    expect(a.map((r) => r.id)).toEqual([RSVP_INVITE_A_ID]);
    expect(a.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(b.map((r) => r.id)).toEqual([RSVP_INVITE_B_ID]);
  });

  it("globally-unique token is lane-scoped: findUnique({ token: B }) under A's store misses (the public bootstrap)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.rsvpInvite.findUnique({ where: { token: RSVP_INVITE_B_TOKEN }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("RsvpDinner is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.rsvpDinner.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.rsvpDinner.findUnique({ where: { id: RSVP_DINNER_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("RsvpInvite per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.rsvpInvite.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.rsvpInvite.findUnique({ where: { id: RSVP_INVITE_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("2-hop RsvpDinnerResponse is lane-scoped: reading by inviteId resolves own, misses cross-tenant", async () => {
    const own = await runWithTenant(ORG_A_ID, () =>
      db.rsvpDinnerResponse.findMany({ where: { inviteId: RSVP_INVITE_A_ID }, select: { id: true } }),
    );
    expect(own.map((r) => r.id)).toEqual([RSVP_RESPONSE_A_ID]);
    // B's response addressed by its own id under A's store misses (USING).
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.rsvpDinnerResponse.findUnique({ where: { id: RSVP_RESPONSE_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    expect(await runWithTenant(ORG_A_ID, () => db.rsvpDinnerResponse.count())).toBe(1);
  });

  it("fail-closed: flag on but NO tenant store → zero rows on all three tables", async () => {
    expect(await db.rsvpDinner.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.rsvpInvite.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.rsvpDinnerResponse.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating an RsvpDinner for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.rsvpDinner.create({
          data: {
            id: "tenancy-rdin-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled Dinner",
            dinnerAt: new Date("2027-01-11T19:00:00Z"),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK rejects creating an RsvpInvite for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.rsvpInvite.create({
          data: {
            id: "tenancy-rinv-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID,
            token: "tenancy-rtok-smuggled-000000000000",
            inviteeName: "Smuggled VIP",
            inviteeEmail: "smuggled@tenancy.test",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN invite to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.rsvpInvite.update({
          where: { id: RSVP_INVITE_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's dinner cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.rsvpDinner.delete({ where: { id: RSVP_DINNER_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("scoped RsvpDinner by-id read resolves for the tenant's own row", async () => {
    const d = await runWithTenant(ORG_A_ID, () =>
      db.rsvpDinner.findUnique({ where: { id: RSVP_DINNER_A_ID }, select: { organizationId: true } }),
    );
    expect(d?.organizationId).toBe(ORG_A_ID);
  });
});
