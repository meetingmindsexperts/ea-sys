/**
 * Webinar/Zoom sweep (Phase 2, domain pass #6 — the first MULTI-TABLE domain):
 * the flat policies from prisma/rls/webinar.sql — the SAME file the future
 * platform bootstrap applies — enforced end-to-end through the ALS store → SET
 * LOCAL extension → pgbouncer, as the non-owner app_user, across all 6 webinar
 * tables (ZoomMeeting, ZoomAttendance, WebinarPresence, WebinarPoll,
 * WebinarPollResponse, WebinarQuestion).
 *
 * The 6 tables did not originally carry organizationId — migration
 * 20260728140000 denormalized it (backfilled from Event), writers stamp it
 * (C1), and the routes/executors/per-row worker fns wrap in runWithTenant
 * (C2). This proves BOTH layers independently, like Invoice:
 *   - defence #1 (compound-where) blocks a cross-org write even with RLS out
 *     of the picture (owner connection bypasses the non-FORCE policy);
 *   - defence #2 (RLS) blocks deliberately-unscoped reads, incl. the 3-hop
 *     WebinarPollResponse whose org is otherwise only reachable via
 *     WebinarPoll → ZoomMeeting → Event.
 *
 * FIXTURES ARE SEEDED HERE, NOT IN prisma/seed-tenancy.ts — deliberate,
 * one-off deviation from the fixtures-in-seed convention: at sweep time a
 * concurrent session held uncommitted WIP in seed-tenancy.ts + constants.ts
 * (the CRM Group-1 fixtures), and entangling this commit with that WIP was the
 * greater risk (the July-24 shared-checkout incident). The beforeAll seeds via
 * the OWNER connection exactly like the seed script would (idempotent:
 * children-first deleteMany of the fixed ids). Folding these fixtures into
 * seed-tenancy.ts once the CRM sweep lands is a welcome cleanup.
 *
 * ZoomMeeting has no per-org unique — the SAME Zoom meeting number is seeded
 * in both orgs (MediaFile's shared-url pattern), so an unscoped
 * where:{zoomMeetingId} returning only the caller-lane row is what proves
 * scoping. Transport correctness (50-lane pooler interleave) + the boot
 * tripwire are model-independent and already pinned on Event / Contact.
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
  REG_A_ID,
  REG_B_ID,
} from "./constants";

// Webinar-domain fixture ids (local to this file — see the header note).
const SESS_A_ID = "ten-web-sess-a";
const SESS_B_ID = "ten-web-sess-b";
const SESS_B_SPARE_ID = "ten-web-sess-b-spare"; // meeting-less target for the smuggle test
const ZM_A_ID = "ten-web-zm-a";
const ZM_B_ID = "ten-web-zm-b";
const SHARED_ZOOM_NUMBER = "99900011122"; // same Zoom meeting number in BOTH orgs
const ATT_A_ID = "ten-web-att-a";
const ATT_B_ID = "ten-web-att-b";
const PRES_A_ID = "ten-web-pres-a";
const PRES_B_ID = "ten-web-pres-b";
const POLL_A_ID = "ten-web-poll-a";
const POLL_B_ID = "ten-web-poll-b";
const RESP_A_ID = "ten-web-resp-a";
const RESP_B_ID = "ten-web-resp-b";
const Q_A_ID = "ten-web-q-a";
const Q_B_ID = "ten-web-q-b";

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set — the webinar fixtures seed as OWNER");
  return new PrismaClient({ datasourceUrl: url });
}

async function seedLane(
  owner: PrismaClient,
  orgId: string,
  eventId: string,
  registrationId: string,
  ids: {
    sessionId: string;
    zoomId: string;
    attId: string;
    presId: string;
    pollId: string;
    respId: string;
    qId: string;
  },
) {
  await owner.eventSession.create({
    data: {
      id: ids.sessionId,
      eventId,
      name: `Webinar session ${ids.sessionId}`,
      startTime: new Date("2027-01-10T10:00:00Z"),
      endTime: new Date("2027-01-10T11:00:00Z"),
    },
  });
  await owner.zoomMeeting.create({
    data: {
      id: ids.zoomId,
      sessionId: ids.sessionId,
      eventId,
      organizationId: orgId,
      zoomMeetingId: SHARED_ZOOM_NUMBER,
      meetingType: "WEBINAR",
      joinUrl: "https://zoom.us/j/tenancy",
    },
  });
  await owner.zoomAttendance.create({
    data: {
      id: ids.attId,
      zoomMeetingId: ids.zoomId,
      eventId,
      organizationId: orgId,
      sessionId: ids.sessionId,
      name: "Shared Attendee",
      joinTime: new Date("2027-01-10T10:01:00Z"),
      durationSeconds: 3000,
    },
  });
  await owner.webinarPresence.create({
    data: {
      id: ids.presId,
      eventId,
      organizationId: orgId,
      sessionId: ids.sessionId,
      registrationId,
    },
  });
  await owner.webinarPoll.create({
    data: {
      id: ids.pollId,
      zoomMeetingId: ids.zoomId,
      organizationId: orgId,
      title: "Shared Poll",
    },
  });
  await owner.webinarPollResponse.create({
    data: {
      id: ids.respId,
      pollId: ids.pollId,
      organizationId: orgId,
      participantName: "Shared Respondent",
      answers: { q: ["yes"] },
      submittedAt: new Date("2027-01-10T10:30:00Z"),
    },
  });
  await owner.webinarQuestion.create({
    data: {
      id: ids.qId,
      zoomMeetingId: ids.zoomId,
      organizationId: orgId,
      askerName: "Shared Asker",
      question: "Same question, both orgs?",
      askedAt: new Date("2027-01-10T10:45:00Z"),
    },
  });
}

beforeAll(async () => {
  const owner = ownerClient();
  try {
    // Idempotent cleanup, children first (the main seed's org cascade also
    // wipes these when it re-runs — this covers re-running THIS file alone).
    await owner.webinarPollResponse.deleteMany({ where: { id: { in: [RESP_A_ID, RESP_B_ID] } } });
    await owner.webinarPoll.deleteMany({ where: { id: { in: [POLL_A_ID, POLL_B_ID] } } });
    await owner.webinarQuestion.deleteMany({ where: { id: { in: [Q_A_ID, Q_B_ID] } } });
    await owner.webinarPresence.deleteMany({ where: { id: { in: [PRES_A_ID, PRES_B_ID] } } });
    await owner.zoomAttendance.deleteMany({ where: { id: { in: [ATT_A_ID, ATT_B_ID] } } });
    await owner.zoomMeeting.deleteMany({ where: { id: { in: [ZM_A_ID, ZM_B_ID, "ten-web-zm-smuggled"] } } });
    await owner.eventSession.deleteMany({
      where: { id: { in: [SESS_A_ID, SESS_B_ID, SESS_B_SPARE_ID] } },
    });

    await seedLane(owner, ORG_A_ID, EVENT_A_SHARED_ID, REG_A_ID, {
      sessionId: SESS_A_ID,
      zoomId: ZM_A_ID,
      attId: ATT_A_ID,
      presId: PRES_A_ID,
      pollId: POLL_A_ID,
      respId: RESP_A_ID,
      qId: Q_A_ID,
    });
    await seedLane(owner, ORG_B_ID, EVENT_B_SHARED_ID, REG_B_ID, {
      sessionId: SESS_B_ID,
      zoomId: ZM_B_ID,
      attId: ATT_B_ID,
      presId: PRES_B_ID,
      pollId: POLL_B_ID,
      respId: RESP_B_ID,
      qId: Q_B_ID,
    });
    // A meeting-less session in org B — the FK target for the WITH CHECK
    // smuggle test (ZoomMeeting.sessionId is unique, so B's main session
    // can't take a second meeting and the unique check would fire first).
    await owner.eventSession.create({
      data: {
        id: SESS_B_SPARE_ID,
        eventId: EVENT_B_SHARED_ID,
        name: "Spare (smuggle target)",
        startTime: new Date("2027-01-11T10:00:00Z"),
        endTime: new Date("2027-01-11T11:00:00Z"),
      },
    });
  } finally {
    await owner.$disconnect();
  }
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Webinar-domain RLS (prisma/rls/webinar.sql) via the SET LOCAL extension", () => {
  it("scoped ZoomMeeting findMany returns ONLY the tenant's own meetings", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.zoomMeeting.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([ZM_A_ID]);
  });

  it("the SHARED Zoom meeting number resolves per-lane: an unscoped lookup sees only the caller's row", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.zoomMeeting.findMany({ where: { zoomMeetingId: SHARED_ZOOM_NUMBER }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.zoomMeeting.findMany({ where: { zoomMeetingId: SHARED_ZOOM_NUMBER }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([ZM_A_ID]);
    expect(b.map((r) => r.id)).toEqual([ZM_B_ID]);
  });

  it("cross-tenant miss by id: B's meeting is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.zoomMeeting.findUnique({ where: { id: ZM_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows on every webinar table", async () => {
    expect(await db.zoomMeeting.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.zoomAttendance.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.webinarPresence.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.webinarPoll.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.webinarPollResponse.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.webinarQuestion.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("every child table is lane-scoped: each org counts exactly its own row", async () => {
    for (const [orgId, expected] of [
      [ORG_A_ID, 1],
      [ORG_B_ID, 1],
    ] as const) {
      expect(await runWithTenant(orgId, () => db.zoomAttendance.count())).toBe(expected);
      expect(await runWithTenant(orgId, () => db.webinarPresence.count())).toBe(expected);
      expect(await runWithTenant(orgId, () => db.webinarPoll.count())).toBe(expected);
      expect(await runWithTenant(orgId, () => db.webinarPollResponse.count())).toBe(expected);
      expect(await runWithTenant(orgId, () => db.webinarQuestion.count())).toBe(expected);
    }
  });

  it("the 3-hop WebinarPollResponse is invisible cross-tenant even when addressed by its parent pollId", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.webinarPollResponse.findMany({ where: { pollId: POLL_B_ID }, select: { id: true } }),
    );
    expect(leaked).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a ZoomMeeting for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.zoomMeeting.create({
          data: {
            id: "ten-web-zm-smuggled",
            sessionId: SESS_B_SPARE_ID,
            eventId: EVENT_B_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            zoomMeetingId: "55500099911",
            meetingType: "WEBINAR",
            joinUrl: "https://zoom.us/j/smuggled",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN meeting to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.zoomMeeting.update({
          where: { id: ZM_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's meeting cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.zoomMeeting.delete({ where: { id: ZM_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: the session→event compound-where blocks a cross-org update even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy, so this exercises ONLY the
    // C1 layer — the { sessionId/id, eventId } binding the zoom session route's
    // PUT/DELETE now use. Wrong-event binding must P2025, row untouched.
    const owner = ownerClient();
    try {
      await expect(
        owner.zoomMeeting.update({
          where: { id: ZM_B_ID, eventId: EVENT_A_SHARED_ID },
          data: { passcode: "hijacked" },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      const row = await owner.zoomMeeting.findUnique({
        where: { id: ZM_B_ID },
        select: { passcode: true },
      });
      expect(row?.passcode).toBeNull();
    } finally {
      await owner.$disconnect();
    }
  });
});
