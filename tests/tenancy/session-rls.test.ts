/**
 * Sessions/Tracks domain sweep (Domain #12): the flat policies from
 * prisma/rls/session.sql — the SAME file the future platform bootstrap applies —
 * enforced end-to-end through the ALS store → SET LOCAL extension → pgbouncer, as
 * the non-owner app_user, across Track + EventSession + SessionTopic +
 * SessionSpeaker + TopicSpeaker.
 *
 * Domain-specific proofs beyond the standard set:
 *   - SessionTopic is 2-hop (sessionId → EventSession → Event), SessionSpeaker is
 *     a 2-hop COMPOSITE-PK join table, TopicSpeaker is a 3-hop COMPOSITE-PK join
 *     table — each backfilled column proven lane-scoped independently, incl. when
 *     addressed by the parent sessionId/topicId (the agenda/roster read shape).
 *
 * No defence-#1-in-isolation assertion: the session mutations bind the org via a
 * prior org-scoped load / the service's org-scoped where (the CRM precedent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  TRACK_A_ID,
  TRACK_B_ID,
  SESSION_A_ID,
  SESSION_B_ID,
  SESSION_TOPIC_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Session RLS (prisma/rls/session.sql) via the SET LOCAL extension", () => {
  it("scoped EventSession findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.eventSession.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([SESSION_A_ID]);
  });

  it("scoped Track findMany returns ONLY the tenant's own rows", async () => {
    const a = await runWithTenant(ORG_A_ID, () => db.track.findMany({ select: { id: true } }));
    const b = await runWithTenant(ORG_B_ID, () => db.track.findMany({ select: { id: true } }));
    expect(a.map((r) => r.id)).toEqual([TRACK_A_ID]);
    expect(b.map((r) => r.id)).toEqual([TRACK_B_ID]);
  });

  it("cross-tenant miss by id: B's EventSession is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.eventSession.findUnique({ where: { id: SESSION_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("SessionTopic (2-hop) is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.sessionTopic.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.sessionTopic.findUnique({ where: { id: SESSION_TOPIC_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("SessionSpeaker (2-hop composite PK) is lane-scoped, incl. addressed by sessionId", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.sessionSpeaker.count())).toBe(1);
    // The roster/agenda read shape: by the OTHER org's sessionId → empty under A.
    const byForeignSession = await runWithTenant(ORG_A_ID, () =>
      db.sessionSpeaker.findMany({ where: { sessionId: SESSION_B_ID }, select: { speakerId: true } }),
    );
    expect(byForeignSession).toHaveLength(0);
  });

  it("TopicSpeaker (3-hop composite PK) is lane-scoped, incl. addressed by topicId", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.topicSpeaker.count())).toBe(1);
    const byForeignTopic = await runWithTenant(ORG_A_ID, () =>
      db.topicSpeaker.findMany({ where: { topicId: SESSION_TOPIC_B_ID }, select: { speakerId: true } }),
    );
    expect(byForeignTopic).toHaveLength(0);
  });

  it("fail-closed: flag on but NO tenant store → zero rows on all 5 tables", async () => {
    expect(await db.track.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.eventSession.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.sessionTopic.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.sessionSpeaker.findMany({ select: { speakerId: true } })).toHaveLength(0);
    expect(await db.topicSpeaker.findMany({ select: { speakerId: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a Track for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.track.create({
          data: {
            id: "tenancy-trk-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled Track",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN EventSession to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.eventSession.update({
          where: { id: SESSION_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's EventSession cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.eventSession.delete({ where: { id: SESSION_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
