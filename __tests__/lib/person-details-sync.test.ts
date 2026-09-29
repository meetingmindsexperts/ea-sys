/**
 * Personal-details sync between a Speaker and the same person's Registration
 * (Sep 29, 2026). Pins: only CHANGED fields travel, same event only, a legacy
 * Attendee shared with another registration is never written, and a failure
 * logs instead of throwing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn(), updateMany: vi.fn() },
    attendee: { updateMany: vi.fn() },
    speaker: { findMany: vi.fn(), updateMany: vi.fn() },
    auditLog: { createMany: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import {
  computeDetailsDelta,
  syncRegistrationDetailsToSpeakers,
  syncSpeakerDetailsToRegistrations,
} from "@/lib/person-details-sync";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.createMany.mockResolvedValue({ count: 1 });
});

describe("computeDetailsDelta", () => {
  it("returns only the synced fields that changed", () => {
    const delta = computeDetailsDelta(
      { firstName: "Ana", lastName: "Silva", phone: null, organization: "Cairo University" },
      { firstName: "Ana", lastName: "Silva", phone: "+971500000000", organization: "Cairo University" },
    );
    expect(delta).toEqual({ phone: "+971500000000" });
  });

  it("treats whitespace-only differences as no change", () => {
    const delta = computeDetailsDelta({ organization: "Cairo university " }, { organization: "Cairo university" });
    expect(delta).toEqual({});
  });

  it("carries a clear (value to null) across", () => {
    expect(computeDetailsDelta({ jobTitle: "Consultant" }, { jobTitle: null })).toEqual({ jobTitle: null });
  });

  it("never copies an empty first or last name (both columns are required)", () => {
    expect(computeDetailsDelta({ firstName: "Ana" }, { firstName: "  " })).toEqual({});
  });

  it("lowercases a copied additional email", () => {
    expect(computeDetailsDelta({}, { additionalEmail: " Ana.Alt@X.com " })).toEqual({ additionalEmail: "ana.alt@x.com" });
  });

  it("ignores fields outside the synced set (email, tags, website)", () => {
    const before = { email: "a@x.com", tags: ["vip"], website: "a.com" } as Record<string, unknown>;
    const after = { email: "b@x.com", tags: ["faculty"], website: "b.com" } as Record<string, unknown>;
    expect(computeDetailsDelta(before, after)).toEqual({});
  });
});

describe("syncSpeakerDetailsToRegistrations", () => {
  const base = { eventId: "ev1", speakerId: "s1", email: "Ana@X.com", sourceRegistrationId: "r1" };

  it("does nothing on an empty delta", async () => {
    await syncSpeakerDetailsToRegistrations({ ...base, delta: {} });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });

  it("writes the delta to the same-event attendee, matched by link or email", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendeeId: "a1", attendee: { _count: { registrations: 1 } } },
    ]);
    await syncSpeakerDetailsToRegistrations({ ...base, delta: { phone: "123" } });

    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.OR).toEqual([
      { id: "r1" },
      { attendee: { email: { equals: "Ana@X.com", mode: "insensitive" } } },
    ]);
    expect(mockDb.attendee.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] } }, data: { phone: "123" } });
  });

  it("moves the registration's version token so a stale editor gets a reload (M1)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendeeId: "a1", attendee: { _count: { registrations: 1 } } },
    ]);
    await syncSpeakerDetailsToRegistrations({ ...base, delta: { phone: "123" } });
    const call = mockDb.registration.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ["r1"] } });
    expect(call.data.updatedAt).toBeInstanceOf(Date);
  });

  it("audits the registration it changed, naming the speaker it came from (M2)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendeeId: "a1", attendee: { phone: "999", _count: { registrations: 1 } } },
    ]);
    await syncSpeakerDetailsToRegistrations({ ...base, delta: { phone: "123" }, actorUserId: "u1" });
    const row = mockDb.auditLog.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ eventId: "ev1", userId: "u1", entityType: "Registration", entityId: "r1" });
    expect(row.changes).toMatchObject({
      source: "person-details-sync",
      syncedFrom: { entityType: "Speaker", entityId: "s1" },
      before: { phone: "999" },
      after: { phone: "123" },
      fields: ["phone"],
    });
  });

  it("skips (and logs) an attendee that backs a registration at another event", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", attendeeId: "shared", attendee: { _count: { registrations: 3 } } },
    ]);
    await syncSpeakerDetailsToRegistrations({ ...base, delta: { phone: "123" } });
    expect(mockDb.attendee.updateMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "person-details-sync:skipped-shared-attendee", attendeeId: "shared" }),
    );
  });

  it("logs and swallows a failure (never fails the primary edit)", async () => {
    mockDb.registration.findMany.mockRejectedValue(new Error("db down"));
    await expect(syncSpeakerDetailsToRegistrations({ ...base, delta: { phone: "123" } })).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "person-details-sync:speaker-to-registration-failed" }),
    );
  });
});

describe("syncRegistrationDetailsToSpeakers", () => {
  const base = { eventId: "ev1", registrationId: "r1", email: "ana@x.com" };

  it("writes the delta to same-event speakers matched by link or email", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "s1" }]);
    mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
    await syncRegistrationDetailsToSpeakers({ ...base, delta: { organization: "Tawam" } });
    expect(mockDb.speaker.findMany.mock.calls[0][0].where).toEqual({
      eventId: "ev1",
      OR: [{ sourceRegistrationId: "r1" }, { email: { equals: "ana@x.com", mode: "insensitive" } }],
    });
    const call = mockDb.speaker.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ["s1"] } });
    expect(call.data).toMatchObject({ organization: "Tawam" });
    expect(call.data.updatedAt).toBeInstanceOf(Date);
    expect(mockDb.auditLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ entityType: "Speaker", entityId: "s1" });
  });

  it("does nothing on an empty delta", async () => {
    await syncRegistrationDetailsToSpeakers({ ...base, delta: {} });
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
  });

  it("logs and swallows a failure", async () => {
    mockDb.speaker.findMany.mockRejectedValue(new Error("db down"));
    await expect(syncRegistrationDetailsToSpeakers({ ...base, delta: { phone: "1" } })).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "person-details-sync:registration-to-speaker-failed" }),
    );
  });
});
