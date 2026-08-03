/**
 * Survey domain sweep (Domain #16): the flat policy from prisma/rls/survey.sql
 * — the SAME file the future platform bootstrap applies — enforced end-to-end
 * through the ALS store → SET LOCAL extension → pgbouncer, as the non-owner
 * app_user, on SurveyResponse (1-hop from Event).
 *
 * Domain-specific proofs:
 *   - registrationId is GLOBALLY unique (@unique — the one-response dedup
 *     gate). A cross-tenant `findUnique({ registrationId })` under the wrong
 *     lane returns NULL (the IssuedCertificate-serial / RSVP-token shape).
 *   - The dashboard reporting read shape (`findMany({ where: { eventId } })`)
 *     addressed at the OTHER org's event resolves empty.
 *
 * No WITH CHECK create-smuggle assertion: SurveyResponse.registrationId is a
 * globally-unique FK and both seeded registrations already hold a response, so
 * there is no insertable fixture without seeding a spare registration+attendee
 * chain. The org-re-home UPDATE block below exercises the SAME WITH CHECK
 * predicate on the write path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_B_SHARED_ID,
  REG_B_ID,
  SURVEY_RESPONSE_A_ID,
  SURVEY_RESPONSE_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Survey RLS (prisma/rls/survey.sql) via the SET LOCAL extension", () => {
  it("SurveyResponse is lane-scoped: per-lane count + scoped by-id read", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.surveyResponse.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.surveyResponse.count())).toBe(1);
    const own = await runWithTenant(ORG_A_ID, () =>
      db.surveyResponse.findUnique({
        where: { id: SURVEY_RESPONSE_A_ID },
        select: { organizationId: true },
      }),
    );
    expect(own?.organizationId).toBe(ORG_A_ID);
  });

  it("cross-tenant by-id miss: B's response is invisible under A's store (USING)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.surveyResponse.findUnique({ where: { id: SURVEY_RESPONSE_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("globally-unique registrationId is lane-scoped: findUnique({ registrationId: B }) under A misses (the dedup-gate read shape)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.surveyResponse.findUnique({ where: { registrationId: REG_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the dashboard reporting read shape addressed at the OTHER org's event resolves empty", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.surveyResponse.findMany({ where: { eventId: EVENT_B_SHARED_ID }, select: { id: true } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    expect(await db.surveyResponse.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN response to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.surveyResponse.update({
          where: { id: SURVEY_RESPONSE_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's response cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.surveyResponse.delete({ where: { id: SURVEY_RESPONSE_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
