/**
 * StreamRecording and StreamRecordingSegment RLS (prisma/rls/webinar.sql): a
 * recording of a partner's stream, and its pieces, are visible and writable
 * only in their own organisation's lane (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md, step 1).
 *
 * The rows say where a client's recording is stored, so a cross-tenant read
 * would point one organisation at another's video. Fixtures are local to this
 * file, like externalstream-rls.test.ts: one session, one recording and one
 * piece per organisation, plus a spare session in B as the target of the
 * smuggle test.
 *
 * Also pins a known limit: with no tenant in scope both tables read as empty,
 * which is how the minute sweep (it reads across organisations with no tenant)
 * finds nothing to keep in step on an instance with row policies, until it
 * moves to the operator lane (ROADMAP, "Webinar streaming", item 2). Master
 * has no RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID } from "./constants";

const SESS_A_ID = "ten-rec-sess-a";
const SESS_B_ID = "ten-rec-sess-b";
const SESS_B_SPARE_ID = "ten-rec-sess-b-spare";
const REC_A_ID = "ten-rec-a";
const REC_B_ID = "ten-rec-b";
const REC_SMUGGLED_ID = "ten-rec-smuggled";
const SEG_A_ID = "ten-rec-seg-a";
const SEG_B_ID = "ten-rec-seg-b";
const SEG_SMUGGLED_ID = "ten-rec-seg-smuggled";
const AGREED = new Date("2027-02-10T09:55:00Z");

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set: the stream-recording fixtures seed as OWNER");
  return new PrismaClient({ datasourceUrl: url });
}

async function seedSession(owner: PrismaClient, id: string, eventId: string) {
  await owner.eventSession.create({
    data: {
      id,
      eventId,
      name: `Recorded session ${id}`,
      startTime: new Date("2027-02-10T10:00:00Z"),
      endTime: new Date("2027-02-10T11:00:00Z"),
    },
  });
}

const recording = (id: string, sessionId: string, eventId: string, organizationId: string) => ({
  id,
  sessionId,
  eventId,
  organizationId,
  partnerAgreedAt: AGREED,
  storagePrefix: `/uploads/recordings/${eventId}/${sessionId}/${id}`,
});

const segment = (id: string, recordingId: string, organizationId: string) => ({
  id,
  recordingId,
  organizationId,
  seq: 0,
  sourceName: "2027-02-10_10-00-00-000000.ts",
  startedAt: new Date("2027-02-10T10:00:00Z"),
  durationMs: 6000,
  bytes: 1_900_000,
  storedPath: `/uploads/recordings/x/y/${recordingId}/seg-000000.ts`,
});

beforeAll(async () => {
  const owner = ownerClient();
  try {
    // Idempotent: this file can be re-run alone. Pieces go with their recording (cascade).
    await owner.streamRecording.deleteMany({ where: { id: { in: [REC_A_ID, REC_B_ID, REC_SMUGGLED_ID] } } });
    await owner.eventSession.deleteMany({ where: { id: { in: [SESS_A_ID, SESS_B_ID, SESS_B_SPARE_ID] } } });

    await seedSession(owner, SESS_A_ID, EVENT_A_SHARED_ID);
    await seedSession(owner, SESS_B_ID, EVENT_B_SHARED_ID);
    await seedSession(owner, SESS_B_SPARE_ID, EVENT_B_SHARED_ID);
    await owner.streamRecording.create({ data: recording(REC_A_ID, SESS_A_ID, EVENT_A_SHARED_ID, ORG_A_ID) });
    await owner.streamRecording.create({ data: recording(REC_B_ID, SESS_B_ID, EVENT_B_SHARED_ID, ORG_B_ID) });
    await owner.streamRecordingSegment.create({ data: segment(SEG_A_ID, REC_A_ID, ORG_A_ID) });
    await owner.streamRecordingSegment.create({ data: segment(SEG_B_ID, REC_B_ID, ORG_B_ID) });
  } finally {
    await owner.$disconnect();
  }
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("StreamRecording RLS (prisma/rls/webinar.sql) via the SET LOCAL extension", () => {
  it("each organisation sees only its own recording and its own pieces", async () => {
    const [recA, segA] = await runWithTenant(ORG_A_ID, () =>
      Promise.all([
        db.streamRecording.findMany({ select: { id: true, organizationId: true } }),
        db.streamRecordingSegment.findMany({ select: { id: true } }),
      ]),
    );
    const [recB, segB] = await runWithTenant(ORG_B_ID, () =>
      Promise.all([db.streamRecording.findMany({ select: { id: true } }), db.streamRecordingSegment.findMany({ select: { id: true } })]),
    );
    expect(recA).toEqual([{ id: REC_A_ID, organizationId: ORG_A_ID }]);
    expect(segA.map((r) => r.id)).toEqual([SEG_A_ID]);
    expect(recB.map((r) => r.id)).toEqual([REC_B_ID]);
    expect(segB.map((r) => r.id)).toEqual([SEG_B_ID]);
  });

  it("another organisation's recording cannot be read by id or by session, nor its pieces by recording", async () => {
    const [byId, bySession, pieces] = await runWithTenant(ORG_A_ID, () =>
      Promise.all([
        db.streamRecording.findUnique({ where: { id: REC_B_ID }, select: { storagePrefix: true } }),
        db.streamRecording.findFirst({ where: { sessionId: SESS_B_ID }, select: { storagePrefix: true } }),
        db.streamRecordingSegment.findMany({ where: { recordingId: REC_B_ID }, select: { storedPath: true } }),
      ]),
    );
    expect(byId).toBeNull();
    expect(bySession).toBeNull();
    expect(pieces).toEqual([]);
  });

  it("fail-closed: with no tenant in scope both tables read as empty", async () => {
    expect(await db.streamRecording.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.streamRecordingSegment.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects starting a recording in ANOTHER organisation", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        // tenant A writing into B
        db.streamRecording.create({ data: recording(REC_SMUGGLED_ID, SESS_B_SPARE_ID, EVENT_B_SHARED_ID, ORG_B_ID) }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK rejects a piece stamped with ANOTHER organisation, even on one's own recording", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.streamRecordingSegment.create({ data: { ...segment(SEG_SMUGGLED_ID, REC_A_ID, ORG_B_ID), seq: 1, sourceName: "smuggled.ts" } }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("another organisation's recording cannot be stopped or deleted", async () => {
    const touched = await runWithTenant(ORG_A_ID, () =>
      db.streamRecording.updateMany({ where: { id: REC_B_ID }, data: { status: "FINISHING" } }),
    );
    expect(touched.count).toBe(0);
    await expect(runWithTenant(ORG_A_ID, () => db.streamRecording.delete({ where: { id: REC_B_ID } }))).rejects.toMatchObject({
      code: "P2025",
    });

    const owner = ownerClient();
    try {
      const row = await owner.streamRecording.findUnique({ where: { id: REC_B_ID }, select: { status: true } });
      expect(row).toEqual({ status: "RECORDING" });
    } finally {
      await owner.$disconnect();
    }
  });

  it("an organisation cannot move its own recording to another organisation (WITH CHECK on update)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.streamRecording.update({ where: { id: REC_A_ID }, data: { organizationId: ORG_B_ID } })),
    ).rejects.toThrow(/row-level security|denied/i);
  });
});
